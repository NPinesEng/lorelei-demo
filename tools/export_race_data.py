"""
Export race data from SQLite to JSON for static website.
Uses pre-calculated scoring data from the Scoring table.

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

# Database paths
DB_PATH = Path(__file__).parent.parent.parent / 'LoreleiV2' / 'database' / 'main.db'
YORANCH_DB = Path(__file__).parent.parent.parent / 'LoreleiV2' / 'database' / 'backups' / 'yoranchdb.db'
OUTPUT_DIR = Path(__file__).parent.parent / 'data'

# Color palette - expanded for more distinct colors
COLOR_OPTIONS = [
    '#e41a1c',  # red
    '#377eb8',  # blue
    '#4daf4a',  # green
    '#ff7f00',  # orange
    '#984ea3',  # purple
    '#f781bf',  # pink
    '#a65628',  # brown
    '#00bcd4',  # cyan
    '#ffeb3b',  # yellow
    '#8bc34a',  # light green
    '#e91e63',  # magenta
    '#9c27b0',  # deep purple
]


def get_runner_color(index: int) -> str:
    """Get color for runner based on index (ensures unique colors)"""
    return COLOR_OPTIONS[index % len(COLOR_OPTIONS)]


def get_node_color(node_id: str) -> str:
    """Generate consistent color based on node_id hash (legacy, for YO Ranch)"""
    hash_value = int(hashlib.md5(node_id.encode()).hexdigest(), 16)
    return COLOR_OPTIONS[hash_value % len(COLOR_OPTIONS)]


def format_runner_name(name: str) -> str:
    """Format runner name: first name only, capitalized."""
    if not name:
        return "Unknown"
    first_name = name.split()[0]
    return first_name.capitalize()


def get_scoring_data(cursor, runner_ids: list) -> dict:
    """Get scoring data for specific runners."""
    if not runner_ids:
        return {}

    placeholders = ','.join('?' * len(runner_ids))
    cursor.execute(f"""
        SELECT runner_number, runner_name, exited_start, stage_timestamps,
               enter_finish, total_run_time
        FROM scoring
        WHERE runner_number IN ({placeholders})
    """, runner_ids)

    scoring = {}
    for row in cursor.fetchall():
        runner_id = row['runner_number']
        stage_timestamps = json.loads(row['stage_timestamps']) if row['stage_timestamps'] else {}

        scoring[runner_id] = {
            'exited_start': row['exited_start'],
            'enter_finish': row['enter_finish'],
            'total_run_time': row['total_run_time'],
            'stage_timestamps': stage_timestamps
        }

    return scoring


def get_runners_from_scoring(cursor, start_date: str, end_date: str, exclude_dnf: bool = True) -> list:
    """
    Get runners from Scoring table for a specific date range.
    Returns list of (runner_number, runner_name, exited_start, enter_finish, total_run_time, stage_timestamps)
    """
    query = """
        SELECT runner_number, runner_name, exited_start, stage_timestamps,
               enter_finish, total_run_time
        FROM scoring
        WHERE exited_start IS NOT NULL
          AND datetime(exited_start, 'unixepoch', 'localtime') >= ?
          AND datetime(exited_start, 'unixepoch', 'localtime') < ?
    """
    if exclude_dnf:
        query += " AND enter_finish IS NOT NULL"
    query += " ORDER BY exited_start"

    cursor.execute(query, (start_date, end_date))

    runners = []
    for row in cursor.fetchall():
        stage_timestamps = json.loads(row['stage_timestamps']) if row['stage_timestamps'] else {}
        runners.append({
            'runner_number': row['runner_number'],
            'runner_name': row['runner_name'],
            'exited_start': row['exited_start'],
            'enter_finish': row['enter_finish'],
            'total_run_time': row['total_run_time'],
            'stage_timestamps': stage_timestamps
        })

    return runners


def get_node_for_runner(cursor, runner_id: int, timestamp: float) -> str:
    """Find the node assigned to a runner at a specific time."""
    cursor.execute("""
        SELECT node_id FROM node_assignment
        WHERE runner_number = ? AND timestamp <= ? AND type = 'assign'
        ORDER BY timestamp DESC LIMIT 1
    """, (runner_id, timestamp))
    row = cursor.fetchone()
    return row['node_id'] if row else None


def get_runner_node_time_range(cursor, runner_id: int, race_start: float, race_end: float) -> tuple:
    """
    Get the node assignment and time range for a runner during a race period.
    Returns (node_id, assign_time, unassign_time) or (None, None, None) if not found.
    """
    # Find the assign event
    cursor.execute("""
        SELECT node_id, timestamp FROM node_assignment
        WHERE runner_number = ? AND type = 'assign' AND timestamp <= ?
        ORDER BY timestamp DESC LIMIT 1
    """, (runner_id, race_end))
    assign_row = cursor.fetchone()

    if not assign_row:
        return None, None, None

    node_id = assign_row['node_id']
    assign_time = assign_row['timestamp']

    # Find the unassign event for this runner after the assign
    cursor.execute("""
        SELECT timestamp FROM node_assignment
        WHERE runner_number = ? AND node_id = ? AND type = 'unassign' AND timestamp > ?
        ORDER BY timestamp ASC LIMIT 1
    """, (runner_id, node_id, assign_time))
    unassign_row = cursor.fetchone()

    unassign_time = unassign_row['timestamp'] if unassign_row else race_end

    return node_id, assign_time, unassign_time


def get_assignments_during_period(cursor, start_time: float, end_time: float) -> dict:
    """Find all node-to-runner assignments that were active during the time period."""
    cursor.execute("""
        SELECT runner_number, node_id, timestamp, type
        FROM node_assignment
        WHERE timestamp <= ?
        ORDER BY timestamp ASC
    """, (end_time,))

    node_active_periods = {}
    current_assignments = {}

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
    node_to_runner = {}
    runner_to_node = {}
    for node_id, periods in node_active_periods.items():
        for assign_start, assign_end, runner in periods:
            if assign_start <= end_time and assign_end >= start_time:
                node_to_runner[node_id] = runner
                runner_to_node[runner] = node_id
                break

    return node_to_runner, runner_to_node


def get_yoranch_data():
    """Get runners, geofences, and scoring from YO Ranch backup database."""
    conn = sqlite3.connect(str(YORANCH_DB))
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # Get runners
    cursor.execute("SELECT id, name FROM Runner ORDER BY id")
    runners = [{'id': row['id'], 'name': row['name']} for row in cursor.fetchall()]

    # Get geofences (deduplicate by taking last of each type+sequence)
    cursor.execute("SELECT id, type, sequence, latitude, longitude, radius FROM Geofence")
    gf_map = {}
    for row in cursor.fetchall():
        key = (row['type'], row['sequence'])
        gf_map[key] = {
            'id': row['id'],
            'type': row['type'],
            'sequence': row['sequence'] or 1,
            'latitude': row['latitude'],
            'longitude': row['longitude'],
            'radius': row['radius']
        }
    geofences = list(gf_map.values())

    # Get scoring data
    cursor.execute("""
        SELECT runner_number, runner_name, exited_start, stage_timestamps,
               enter_finish, total_run_time
        FROM scoring
        WHERE exited_start IS NOT NULL
    """)

    scoring = {}
    for row in cursor.fetchall():
        runner_id = row['runner_number']
        stage_timestamps = json.loads(row['stage_timestamps']) if row['stage_timestamps'] else {}

        scoring[runner_id] = {
            'exited_start': row['exited_start'],
            'enter_finish': row['enter_finish'],
            'total_run_time': row['total_run_time'],
            'stage_timestamps': stage_timestamps
        }

    conn.close()
    return runners, geofences, scoring


def calculate_time_bounds(scoring_data: dict):
    """
    Calculate race time bounds from scoring data.
    Returns (start_time, end_time) where:
    - start_time = first exit_start - 5 minutes
    - end_time = last enter_finish + 5 minutes (excluding DNFs)
    """
    first_exit_start = None
    last_enter_finish = None

    for runner_id, score in scoring_data.items():
        if score['exited_start']:
            if first_exit_start is None or score['exited_start'] < first_exit_start:
                first_exit_start = score['exited_start']

        # Only count finishers for end time
        if score['enter_finish']:
            if last_enter_finish is None or score['enter_finish'] > last_enter_finish:
                last_enter_finish = score['enter_finish']

    # Add 5 minute buffer
    start_time = first_exit_start - 300 if first_exit_start else None
    end_time = last_enter_finish + 300 if last_enter_finish else None

    return start_time, end_time


def calculate_time_bounds_from_list(runners: list):
    """Calculate time bounds from a list of runner scoring data."""
    first_exit_start = None
    last_enter_finish = None

    for r in runners:
        if r['exited_start']:
            if first_exit_start is None or r['exited_start'] < first_exit_start:
                first_exit_start = r['exited_start']
        if r['enter_finish']:
            if last_enter_finish is None or r['enter_finish'] > last_enter_finish:
                last_enter_finish = r['enter_finish']

    start_time = first_exit_start - 300 if first_exit_start else None
    end_time = last_enter_finish + 300 if last_enter_finish else None

    return start_time, end_time


def export_race_from_scoring(
    db_path: Path,
    output_dir: Path,
    race_name: str,
    start_date: str,
    end_date: str,
    race_display_name: str = None
):
    """Export race data using Scoring table as the source of truth."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    output_path = output_dir / race_name
    output_path.mkdir(parents=True, exist_ok=True)

    print(f"\nExporting {race_name}...")
    print(f"  Date range: {start_date} to {end_date}")

    # Get runners from Scoring table (finishers only)
    scoring_runners = get_runners_from_scoring(cursor, start_date, end_date, exclude_dnf=True)
    print(f"  Found {len(scoring_runners)} finishers in Scoring table")

    if not scoring_runners:
        print("  ERROR: No runners found!")
        conn.close()
        return False

    # Calculate time bounds
    start_time, end_time = calculate_time_bounds_from_list(scoring_runners)
    print(f"  Time range: {datetime.fromtimestamp(start_time)} to {datetime.fromtimestamp(end_time)}")

    # Get geofences
    cursor.execute("SELECT * FROM geofence")
    geofences = []
    for row in cursor.fetchall():
        geofences.append({
            'id': row['id'],
            'type': row['type'],
            'sequence': row['sequence'] or 1,
            'latitude': row['latitude'],
            'longitude': row['longitude'],
            'radius': row['radius']
        })

    total_stages = len([g for g in geofences if g['type'] == 'stage'])

    # Build runners list and scoring data
    runners = []
    scoring_data = {}
    runner_node_ranges = []  # (runner_id, node_id, start_time, end_time)

    for i, sr in enumerate(scoring_runners):
        runner_id = i + 1  # Use sequential IDs for simplicity
        original_id = sr['runner_number']

        # Get node assignment with time range for this runner
        node_id, node_start, node_end = get_runner_node_time_range(
            cursor, original_id, sr['exited_start'], sr['enter_finish'] or end_time
        )

        runners.append({
            'id': runner_id,
            'name': format_runner_name(sr['runner_name']),
            'node_id': node_id,
            'color': get_runner_color(i),  # Use index for unique colors
            'original_id': original_id  # Keep for debugging
        })

        scoring_data[runner_id] = {
            'exited_start': sr['exited_start'],
            'enter_finish': sr['enter_finish'],
            'total_run_time': sr['total_run_time'],
            'stage_timestamps': sr['stage_timestamps']
        }

        if node_id:
            runner_node_ranges.append((runner_id, node_id, node_start, node_end))

    print(f"  Runners: {[r['name'] for r in runners]}")

    # Build scoring export
    scoring_export = []
    for runner in runners:
        score = scoring_data.get(runner['id'], {})
        stage_timestamps = score.get('stage_timestamps', {})

        completed_stages = sum(1 for times in stage_timestamps.values()
                               if times.get('enter') and times.get('exit'))

        scoring_export.append({
            'runner_id': runner['id'],
            'exited_start': score.get('exited_start'),
            'enter_finish': score.get('enter_finish'),
            'total_run_time': score.get('total_run_time'),
            'stages_completed': completed_stages,
            'total_stages': total_stages,
            'stage_timestamps': stage_timestamps
        })

    # Get positions for each runner based on their node assignment time range
    positions_by_time = {}

    for runner_id, node_id, node_start, node_end in runner_node_ranges:
        cursor.execute("""
            SELECT from_id, latitude, longitude, gps_timestamp
            FROM position
            WHERE from_id = ?
              AND gps_timestamp >= ?
              AND gps_timestamp <= ?
              AND latitude IS NOT NULL
              AND longitude IS NOT NULL
            ORDER BY gps_timestamp ASC
        """, (node_id, int(node_start), int(node_end)))

        for row in cursor.fetchall():
            timestamp = int(row['gps_timestamp'])
            if timestamp not in positions_by_time:
                positions_by_time[timestamp] = {}

            positions_by_time[timestamp][runner_id] = {
                'r': runner_id,
                'lat': round(row['latitude'], 6),
                'lon': round(row['longitude'], 6)
            }

    positions = [
        {'t': ts, 'p': list(pos_dict.values())}
        for ts, pos_dict in sorted(positions_by_time.items())
    ]

    print(f"  Position frames: {len(positions)}")
    print(f"  Scoring entries: {len(scoring_export)}")

    # Determine actual start/end from positions
    if positions:
        actual_start = positions[0]['t']
        actual_end = positions[-1]['t']
    else:
        actual_start = start_time
        actual_end = end_time

    # Remove original_id from runners before saving
    for r in runners:
        r.pop('original_id', None)

    # Save JSON files
    with open(output_path / 'positions.json', 'w') as f:
        json.dump(positions, f)

    with open(output_path / 'geofences.json', 'w') as f:
        json.dump(geofences, f, indent=2)

    with open(output_path / 'runners.json', 'w') as f:
        json.dump(runners, f, indent=2)

    with open(output_path / 'scoring.json', 'w') as f:
        json.dump(scoring_export, f, indent=2)

    metadata = {
        'name': race_display_name or race_name,
        'startTime': int(actual_start),
        'endTime': int(actual_end),
        'runnerCount': len(runners),
        'positionFrames': len(positions),
        'totalStages': total_stages,
        'exportedAt': datetime.now().isoformat()
    }

    with open(output_path / 'metadata.json', 'w') as f:
        json.dump(metadata, f, indent=2)

    conn.close()
    print(f"  Export complete: {output_path}")
    return True


def export_race_data(
    db_path: Path,
    output_dir: Path,
    race_name: str,
    start_time: float,
    end_time: float,
    race_display_name: str = None,
    use_yoranch_backup: bool = False
):
    """Export race data for a specific time range."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    output_path = output_dir / race_name
    output_path.mkdir(parents=True, exist_ok=True)

    print(f"\nExporting {race_name}...")
    print(f"  Initial time range: {datetime.fromtimestamp(start_time)} to {datetime.fromtimestamp(end_time)}")

    # Get node-to-runner mapping
    node_to_runner, runner_to_node = get_assignments_during_period(cursor, start_time, end_time)
    print(f"  Active assignments: {len(node_to_runner)} nodes")

    # Get runners, geofences, and scoring
    if use_yoranch_backup:
        backup_runners, geofences, scoring_data = get_yoranch_data()
        print(f"  Using YO Ranch backup: {len(backup_runners)} runners, {len(geofences)} geofences")

        # Map backup runners to node assignments by runner ID (not index)
        # The backup DB and main DB use the same runner IDs
        runners = []
        for i, br in enumerate(backup_runners):
            # Find the node assigned to this runner ID in the main DB
            node_id = runner_to_node.get(br['id'])
            if node_id:
                runners.append({
                    'id': br['id'],
                    'name': format_runner_name(br['name']),
                    'node_id': node_id,
                    'color': get_runner_color(i)  # Use index for unique colors
                })

        # Scoring data already uses correct runner IDs from backup
        new_node_to_runner = {r['node_id']: r['id'] for r in runners}
    else:
        # Get geofences from main DB
        cursor.execute("SELECT * FROM geofence")
        geofences = []
        for row in cursor.fetchall():
            geofences.append({
                'id': row['id'],
                'type': row['type'],
                'sequence': row['sequence'] or 1,
                'latitude': row['latitude'],
                'longitude': row['longitude'],
                'radius': row['radius']
            })

        # Get runners from main DB with formatted names
        active_runner_ids = list(runner_to_node.keys())
        runners = []
        if active_runner_ids:
            placeholders = ','.join('?' * len(active_runner_ids))
            cursor.execute(f"SELECT * FROM runner WHERE id IN ({placeholders})", active_runner_ids)

            for row in cursor.fetchall():
                node_id = runner_to_node.get(row['id'])
                runners.append({
                    'id': row['id'],
                    'name': format_runner_name(row['name']),
                    'node_id': node_id,
                    'color': get_node_color(node_id) if node_id else '#999999'
                })

        # Get scoring data for these runners
        scoring_data = get_scoring_data(cursor, active_runner_ids)
        new_node_to_runner = node_to_runner

    print(f"  Runners: {[r['name'] for r in runners]}")

    # Calculate time bounds from scoring data
    calc_start, calc_end = calculate_time_bounds(scoring_data)
    if calc_start and calc_end:
        start_time = calc_start
        end_time = calc_end
        print(f"  Adjusted time range from scoring: {datetime.fromtimestamp(start_time)} to {datetime.fromtimestamp(end_time)}")

    # Count stages
    total_stages = len([g for g in geofences if g['type'] == 'stage'])

    # Build scoring export with stage details
    scoring_export = []
    for runner in runners:
        score = scoring_data.get(runner['id'], {})
        stage_timestamps = score.get('stage_timestamps', {})

        # Count completed stages (have both enter and exit)
        completed_stages = 0
        for stage_num, times in stage_timestamps.items():
            if times.get('enter') and times.get('exit'):
                completed_stages += 1

        scoring_export.append({
            'runner_id': runner['id'],
            'exited_start': score.get('exited_start'),
            'enter_finish': score.get('enter_finish'),
            'total_run_time': score.get('total_run_time'),
            'stages_completed': completed_stages,
            'total_stages': total_stages,
            'stage_timestamps': stage_timestamps
        })

    # Get positions within adjusted time range
    assigned_nodes = list(new_node_to_runner.keys())
    positions = []

    if assigned_nodes:
        placeholders = ','.join('?' * len(assigned_nodes))
        cursor.execute(f"""
            SELECT from_id, latitude, longitude, gps_timestamp
            FROM position
            WHERE from_id IN ({placeholders})
              AND gps_timestamp >= ?
              AND gps_timestamp <= ?
              AND latitude IS NOT NULL
              AND longitude IS NOT NULL
            ORDER BY gps_timestamp ASC
        """, assigned_nodes + [int(start_time), int(end_time)])

        # Group by timestamp and deduplicate
        positions_by_time = {}
        for row in cursor.fetchall():
            timestamp = int(row['gps_timestamp'])
            if timestamp not in positions_by_time:
                positions_by_time[timestamp] = {}

            runner_id = new_node_to_runner.get(row['from_id'])
            if runner_id is not None:
                positions_by_time[timestamp][runner_id] = {
                    'r': runner_id,
                    'lat': round(row['latitude'], 6),
                    'lon': round(row['longitude'], 6)
                }

        positions = [
            {'t': ts, 'p': list(pos_dict.values())}
            for ts, pos_dict in sorted(positions_by_time.items())
        ]

    print(f"  Position frames: {len(positions)}")
    print(f"  Scoring entries: {len(scoring_export)}")

    # Determine actual start/end from positions
    if positions:
        actual_start = positions[0]['t']
        actual_end = positions[-1]['t']
    else:
        actual_start = start_time
        actual_end = end_time

    # Save JSON files
    with open(output_path / 'positions.json', 'w') as f:
        json.dump(positions, f)

    with open(output_path / 'geofences.json', 'w') as f:
        json.dump(geofences, f, indent=2)

    with open(output_path / 'runners.json', 'w') as f:
        json.dump(runners, f, indent=2)

    with open(output_path / 'scoring.json', 'w') as f:
        json.dump(scoring_export, f, indent=2)

    metadata = {
        'name': race_display_name or race_name,
        'startTime': int(actual_start),
        'endTime': int(actual_end),
        'runnerCount': len(runners),
        'positionFrames': len(positions),
        'totalStages': total_stages,
        'exportedAt': datetime.now().isoformat()
    }

    with open(output_path / 'metadata.json', 'w') as f:
        json.dump(metadata, f, indent=2)

    conn.close()
    print(f"  Export complete: {output_path}")
    return True


def list_race_resets(db_path: Path):
    """List all race resets in the database."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    print(f"Database: {db_path}")
    print("-" * 80)

    cursor.execute("""
        SELECT id, reset_timestamp, description
        FROM race_reset
        ORDER BY reset_timestamp ASC
    """)
    resets = cursor.fetchall()

    if not resets:
        print("No race resets found.")
        conn.close()
        return

    for reset in resets:
        reset_dt = datetime.fromtimestamp(reset['reset_timestamp'])
        print(f"Reset #{reset['id']}: {reset['description'] or 'No description'}")
        print(f"  Timestamp: {reset['reset_timestamp']} ({reset_dt})")
        print()

    conn.close()


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
        # YO Ranch - Use backup for runners/geofences/scoring
        export_race_data(
            db_path=db_path,
            output_dir=OUTPUT_DIR,
            race_name='yoranch',
            start_time=1763822831,
            end_time=1763855767,
            race_display_name='YO Ranch Trial',
            use_yoranch_backup=True
        )

        # 772 Race Day 1 - Use Scoring table directly, exclude DNFs
        export_race_from_scoring(
            db_path=db_path,
            output_dir=OUTPUT_DIR,
            race_name='772/day1',
            start_date='2025-12-05 00:00:00',
            end_date='2025-12-06 00:00:00',
            race_display_name='772 Endurance - Day 1'
        )

        # 772 Race Day 2 - Use Scoring table directly, exclude DNFs
        export_race_from_scoring(
            db_path=db_path,
            output_dir=OUTPUT_DIR,
            race_name='772/day2',
            start_date='2025-12-06 00:00:00',
            end_date='2025-12-07 00:00:00',
            race_display_name='772 Endurance - Day 2'
        )

        print("\nAll races exported successfully!")
        return

    parser.print_help()


if __name__ == '__main__':
    main()
