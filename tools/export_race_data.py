"""
Export race data from SQLite to JSON for static website.
Queries Position, Geofence, Runner, NodeAssignment, and RaceReset tables
to create replay-ready JSON files.

Usage:
    python export_race_data.py --list-resets    # List all race resets
    python export_race_data.py --export         # Export configured races
"""

import sqlite3
import json
import hashlib
import argparse
from datetime import datetime
from pathlib import Path

# Database path - adjust relative to this script's location
DB_PATH = Path(__file__).parent.parent.parent / 'LoreleiV2' / 'database' / 'main.db'
OUTPUT_DIR = Path(__file__).parent.parent / 'data'

# Color palette matching existing implementation (02_Map.py)
COLOR_OPTIONS = ['#e41a1c', '#377eb8', '#4daf4a', '#ff7f00', '#984ea3', '#f781bf', '#a65628', '#999999']
COLOR_NAMES = ['red', 'blue', 'green', 'orange', 'purple', 'pink', 'brown', 'gray']


def get_node_color(node_id: str) -> str:
    """Generate consistent color based on node_id hash (matching 02_Map.py)"""
    hash_value = int(hashlib.md5(node_id.encode()).hexdigest(), 16)
    return COLOR_OPTIONS[hash_value % len(COLOR_OPTIONS)]


def get_node_color_name(node_id: str) -> str:
    """Generate consistent color name based on node_id hash"""
    hash_value = int(hashlib.md5(node_id.encode()).hexdigest(), 16)
    return COLOR_NAMES[hash_value % len(COLOR_NAMES)]


def list_race_resets(db_path: Path):
    """List all race resets in the database with surrounding data info."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    print(f"Database: {db_path}")
    print("-" * 80)

    # Get all race resets
    cursor.execute("""
        SELECT id, reset_timestamp, description, created_by
        FROM race_reset
        ORDER BY reset_timestamp ASC
    """)
    resets = cursor.fetchall()

    if not resets:
        print("No race resets found in database.")
        conn.close()
        return

    print(f"Found {len(resets)} race reset(s):\n")

    for i, reset in enumerate(resets):
        reset_ts = reset['reset_timestamp']
        reset_dt = datetime.fromtimestamp(reset_ts)

        # Find next reset time (or None if last)
        next_reset_ts = resets[i + 1]['reset_timestamp'] if i + 1 < len(resets) else None

        # Count positions and events after this reset (until next reset)
        if next_reset_ts:
            cursor.execute("""
                SELECT COUNT(*) as cnt FROM position
                WHERE timestamp >= ? AND timestamp < ?
            """, (reset_ts, next_reset_ts))
        else:
            cursor.execute("""
                SELECT COUNT(*) as cnt FROM position
                WHERE timestamp >= ?
            """, (reset_ts,))
        pos_count = cursor.fetchone()['cnt']

        # Get unique nodes in this period
        if next_reset_ts:
            cursor.execute("""
                SELECT DISTINCT from_id FROM position
                WHERE timestamp >= ? AND timestamp < ?
            """, (reset_ts, next_reset_ts))
        else:
            cursor.execute("""
                SELECT DISTINCT from_id FROM position
                WHERE timestamp >= ?
            """, (reset_ts,))
        nodes = [row['from_id'] for row in cursor.fetchall()]

        # Get time range of positions
        if next_reset_ts:
            cursor.execute("""
                SELECT MIN(gps_timestamp) as min_t, MAX(gps_timestamp) as max_t
                FROM position
                WHERE timestamp >= ? AND timestamp < ?
                  AND gps_timestamp IS NOT NULL
            """, (reset_ts, next_reset_ts))
        else:
            cursor.execute("""
                SELECT MIN(gps_timestamp) as min_t, MAX(gps_timestamp) as max_t
                FROM position
                WHERE timestamp >= ?
                  AND gps_timestamp IS NOT NULL
            """, (reset_ts,))
        time_range = cursor.fetchone()

        # Get active runner assignments during this period
        if next_reset_ts:
            cursor.execute("""
                SELECT DISTINCT runner_number FROM node_assignment
                WHERE timestamp >= ? AND timestamp < ? AND type = 'assign'
            """, (reset_ts, next_reset_ts))
        else:
            cursor.execute("""
                SELECT DISTINCT runner_number FROM node_assignment
                WHERE timestamp >= ? AND type = 'assign'
            """, (reset_ts,))
        runners = [row['runner_number'] for row in cursor.fetchall()]

        print(f"Reset #{reset['id']}: {reset['description'] or 'No description'}")
        print(f"  Timestamp: {reset_ts} ({reset_dt.strftime('%Y-%m-%d %H:%M:%S')})")
        print(f"  Positions: {pos_count}")
        print(f"  Nodes: {len(nodes)} - {', '.join(nodes[:5])}{'...' if len(nodes) > 5 else ''}")
        print(f"  Runners assigned: {len(runners)} - {runners}")
        if time_range['min_t'] and time_range['max_t']:
            min_dt = datetime.fromtimestamp(time_range['min_t'])
            max_dt = datetime.fromtimestamp(time_range['max_t'])
            duration = time_range['max_t'] - time_range['min_t']
            hours = duration / 3600
            print(f"  GPS Time Range: {min_dt.strftime('%Y-%m-%d %H:%M')} to {max_dt.strftime('%Y-%m-%d %H:%M')} ({hours:.1f} hours)")
        print()

    conn.close()


def get_assignments_at_time(cursor, end_time: float) -> dict:
    """
    Replay assignment history up to end_time to get node-to-runner mapping.
    Returns dict: {node_id: runner_number}
    """
    cursor.execute("""
        SELECT runner_number, node_id, timestamp, type
        FROM node_assignment
        WHERE timestamp <= ?
        ORDER BY timestamp ASC
    """, (end_time,))

    node_to_runner = {}
    runner_to_node = {}

    for row in cursor.fetchall():
        if row['type'] == 'assign':
            # Remove any previous assignment for this runner
            if row['runner_number'] in runner_to_node:
                old_node = runner_to_node[row['runner_number']]
                if old_node in node_to_runner:
                    del node_to_runner[old_node]
            node_to_runner[row['node_id']] = row['runner_number']
            runner_to_node[row['runner_number']] = row['node_id']
        elif row['type'] == 'unassign':
            if row['node_id'] in node_to_runner:
                runner_num = node_to_runner[row['node_id']]
                del node_to_runner[row['node_id']]
                if runner_num in runner_to_node:
                    del runner_to_node[runner_num]

    return node_to_runner, runner_to_node


def get_assignments_during_period(cursor, start_time: float, end_time: float) -> dict:
    """
    Find all node-to-runner assignments that were active during the time period.
    This handles cases where runners are unassigned before the end time.
    Returns dict: {node_id: runner_number}
    """
    # Get all assignment events during and before the period
    cursor.execute("""
        SELECT runner_number, node_id, timestamp, type
        FROM node_assignment
        WHERE timestamp <= ?
        ORDER BY timestamp ASC
    """, (end_time,))

    # Track all assignments and when they were active
    node_to_runner = {}
    runner_to_node = {}
    node_active_periods = {}  # node_id -> [(start, end, runner)]

    current_assignments = {}  # node_id -> (runner, start_time)

    for row in cursor.fetchall():
        node_id = row['node_id']
        runner = row['runner_number']
        ts = row['timestamp']

        if row['type'] == 'assign':
            current_assignments[node_id] = (runner, ts)
        elif row['type'] == 'unassign':
            if node_id in current_assignments:
                prev_runner, assign_ts = current_assignments[node_id]
                if node_id not in node_active_periods:
                    node_active_periods[node_id] = []
                node_active_periods[node_id].append((assign_ts, ts, prev_runner))
                del current_assignments[node_id]

    # Add still-active assignments
    for node_id, (runner, assign_ts) in current_assignments.items():
        if node_id not in node_active_periods:
            node_active_periods[node_id] = []
        node_active_periods[node_id].append((assign_ts, end_time, runner))

    # Find assignments that overlap with our time period
    for node_id, periods in node_active_periods.items():
        for assign_start, assign_end, runner in periods:
            # Check if this assignment overlaps with our period
            if assign_start <= end_time and assign_end >= start_time:
                node_to_runner[node_id] = runner
                runner_to_node[runner] = node_id
                break  # Take the first matching assignment for this node

    return node_to_runner, runner_to_node


def export_race_data(
    db_path: Path,
    output_dir: Path,
    race_name: str,
    start_time: float,
    end_time: float,
    race_display_name: str = None
):
    """
    Export race data for a specific time range.

    Args:
        db_path: Path to main.db
        output_dir: Output directory for JSON files
        race_name: Name for the race folder (e.g., "yoranch", "772/day1")
        start_time: Unix timestamp for race start
        end_time: Unix timestamp for race end
        race_display_name: Human-readable name for the race
    """
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    output_path = output_dir / race_name
    output_path.mkdir(parents=True, exist_ok=True)

    print(f"Exporting {race_name}...")
    print(f"  Time range: {datetime.fromtimestamp(start_time)} to {datetime.fromtimestamp(end_time)}")

    # 1. Export Geofences
    cursor.execute("SELECT * FROM geofence")
    geofences = []
    for row in cursor.fetchall():
        geofences.append({
            'id': row['id'],
            'type': row['type'],
            'sequence': row['sequence'],
            'latitude': row['latitude'],
            'longitude': row['longitude'],
            'radius': row['radius']
        })

    with open(output_path / 'geofences.json', 'w') as f:
        json.dump(geofences, f, indent=2)
    print(f"  Exported {len(geofences)} geofences")

    # 2. Get node-to-runner mapping for nodes active during race period
    node_to_runner, runner_to_node = get_assignments_during_period(cursor, start_time, end_time)

    print(f"  Active assignments: {len(node_to_runner)} nodes")

    # 3. Export Runners with their assigned colors
    active_runner_ids = list(runner_to_node.keys())
    runners = []

    if active_runner_ids:
        placeholders = ','.join('?' * len(active_runner_ids))
        cursor.execute(f"SELECT * FROM runner WHERE id IN ({placeholders})", active_runner_ids)

        for row in cursor.fetchall():
            node_id = runner_to_node.get(row['id'])
            runners.append({
                'id': row['id'],
                'name': row['name'],
                'node_id': node_id,
                'color': get_node_color(node_id) if node_id else '#999999'
            })

    with open(output_path / 'runners.json', 'w') as f:
        json.dump(runners, f, indent=2)
    print(f"  Exported {len(runners)} runners")

    # 4. Export Positions (the main data)
    assigned_nodes = list(node_to_runner.keys())
    positions = []

    if assigned_nodes:
        placeholders = ','.join('?' * len(assigned_nodes))
        cursor.execute(f"""
            SELECT from_id, latitude, longitude, gps_timestamp, altitude
            FROM position
            WHERE from_id IN ({placeholders})
              AND gps_timestamp >= ?
              AND gps_timestamp <= ?
              AND latitude IS NOT NULL
              AND longitude IS NOT NULL
            ORDER BY gps_timestamp ASC
        """, assigned_nodes + [int(start_time), int(end_time)])

        # Group positions by timestamp for efficient playback
        positions_by_time = {}
        for row in cursor.fetchall():
            timestamp = int(row['gps_timestamp'])
            if timestamp not in positions_by_time:
                positions_by_time[timestamp] = []

            runner_num = node_to_runner.get(row['from_id'])
            if runner_num is not None:
                positions_by_time[timestamp].append({
                    'r': runner_num,  # Shortened key names for smaller file
                    'lat': round(row['latitude'], 6),
                    'lon': round(row['longitude'], 6)
                })

        # Convert to sorted array format for efficient iteration
        positions = [
            {'t': ts, 'p': pos_list}
            for ts, pos_list in sorted(positions_by_time.items())
        ]

    with open(output_path / 'positions.json', 'w') as f:
        json.dump(positions, f)  # No indent for smaller file
    print(f"  Exported {len(positions)} time frames with positions")

    # 5. Export Metadata
    metadata = {
        'name': race_display_name or race_name,
        'startTime': int(start_time),
        'endTime': int(end_time),
        'runnerCount': len(runners),
        'positionFrames': len(positions),
        'exportedAt': datetime.now().isoformat()
    }

    with open(output_path / 'metadata.json', 'w') as f:
        json.dump(metadata, f, indent=2)

    conn.close()
    print(f"  Export complete: {output_path}")
    return True


def main():
    parser = argparse.ArgumentParser(description='Export LoRELEI race data to JSON')
    parser.add_argument('--list-resets', action='store_true', help='List all race resets')
    parser.add_argument('--export', action='store_true', help='Export configured races')
    parser.add_argument('--db', type=str, default=str(DB_PATH), help='Path to database')
    args = parser.parse_args()

    db_path = Path(args.db)

    if not db_path.exists():
        print(f"Database not found: {db_path}")
        return

    if args.list_resets:
        list_race_resets(db_path)
        return

    if args.export:
        # YO Ranch - Nov 22, 2025 (08:47 to 17:56)
        # 4 runners, assignments made at 11:08
        export_race_data(
            db_path=db_path,
            output_dir=OUTPUT_DIR,
            race_name='yoranch',
            start_time=1763822831,  # Nov 22 08:47
            end_time=1763855767,    # Nov 22 17:56
            race_display_name='YO Ranch Trial'
        )

        # 772 Race Day 1 - Dec 5, 2025 (08:46 to 16:02)
        # 5 runners (Kevin, Dan, Carter, Derek, Jeremy)
        export_race_data(
            db_path=db_path,
            output_dir=OUTPUT_DIR,
            race_name='772/day1',
            start_time=1764945980,  # Dec 5 08:46
            end_time=1764972165,    # Dec 5 16:02
            race_display_name='772 Endurance - Day 1'
        )

        # 772 Race Day 2 - Dec 6, 2025 (06:42 to 16:23)
        # 9 runners (Luke, Merrill, Casey, Tyler, Derrick, Cody, Meghan, Todd, Nick)
        export_race_data(
            db_path=db_path,
            output_dir=OUTPUT_DIR,
            race_name='772/day2',
            start_time=1765024936,  # Dec 6 06:42
            end_time=1765059828,    # Dec 6 16:23
            race_display_name='772 Endurance - Day 2'
        )

        print("\nAll races exported successfully!")
        return

    # Default: show help
    parser.print_help()


if __name__ == '__main__':
    main()
