/**
 * ReplayMap - Leaflet map integration for race replay
 * Handles marker rendering, geofences, trails, and camera following
 */
class ReplayMap {
    constructor(containerId, options = {}) {
        this.containerId = containerId;
        this.options = {
            initialZoom: 15,
            maxTrailLength: 50,
            ...options
        };

        // Initialize map
        this.map = L.map(containerId, {
            preferCanvas: true,
            zoomControl: true
        });

        // Add Esri World Imagery satellite tiles
        L.tileLayer(
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            {
                maxZoom: 22,
                maxNativeZoom: 19,
                attribution: 'Esri World Imagery'
            }
        ).addTo(this.map);

        // State
        this.markers = {};           // runnerId -> L.circleMarker
        this.trails = {};            // runnerId -> L.polyline
        this.trailPoints = {};       // runnerId -> array of [lat, lon]
        this.geofenceCircles = [];
        this.runnerData = {};        // runnerId -> runner info

        // Follow mode: 'all', 'none', or runner ID (number)
        this.followMode = 'all';
        this.selectedRunners = new Set();

        // Geofence colors matching existing implementation
        this.geofenceColors = {
            'start': '#22c55e',   // green
            'finish': '#ef4444',  // red
            'stage': '#f97316',   // orange
            'alarm': '#a855f7'    // purple
        };
    }

    /**
     * Load and display geofences
     * @param {Array} geofences - Array of geofence objects
     */
    loadGeofences(geofences) {
        // Clear existing geofences
        this.geofenceCircles.forEach(circle => circle.remove());
        this.geofenceCircles = [];

        geofences.forEach(gf => {
            const color = this.geofenceColors[gf.type] || '#3b82f6';

            const circle = L.circle([gf.latitude, gf.longitude], {
                radius: gf.radius,
                color: color,
                fillColor: color,
                fillOpacity: 0.25,
                weight: 2
            }).addTo(this.map);

            // Create popup content
            const typeName = gf.type.charAt(0).toUpperCase() + gf.type.slice(1);
            const label = gf.type === 'stage' ? `Stage ${gf.sequence}` : typeName;
            circle.bindPopup(`<strong>${label}</strong><br>Radius: ${gf.radius}m`);

            this.geofenceCircles.push(circle);
        });
    }

    /**
     * Load runner data
     * @param {Array} runners - Array of runner objects
     */
    loadRunners(runners) {
        this.runnerData = {};
        this.selectedRunners = new Set();

        runners.forEach(runner => {
            this.runnerData[runner.id] = runner;
            this.selectedRunners.add(runner.id);
        });
    }

    /**
     * Update runner positions on the map
     * @param {Array} positions - Array of position objects with runner info
     */
    updatePositions(positions) {
        const visiblePositions = [];

        positions.forEach(pos => {
            const runnerId = pos.runner.id;

            // Skip if runner not selected
            if (!this.selectedRunners.has(runnerId)) {
                this._hideRunner(runnerId);
                return;
            }

            visiblePositions.push(pos);
            const runner = pos.runner;
            const latLng = [pos.lat, pos.lon];

            // Update or create marker
            if (this.markers[runnerId]) {
                this.markers[runnerId].setLatLng(latLng);
                this.markers[runnerId].setStyle({ opacity: 1, fillOpacity: 0.9 });
            } else {
                const marker = L.circleMarker(latLng, {
                    radius: 8,
                    color: '#ffffff',
                    weight: 2,
                    fillColor: runner.color,
                    fillOpacity: 0.9
                }).addTo(this.map);

                marker.bindTooltip(runner.name, {
                    permanent: false,
                    direction: 'top',
                    offset: [0, -10]
                });

                this.markers[runnerId] = marker;
            }

            // Update trail
            this._updateTrail(runnerId, latLng, runner.color);
        });

        // Update camera based on follow mode
        this._updateCamera(visiblePositions);
    }

    /**
     * Set which runners to display
     * @param {Array} runnerIds - Array of runner IDs to show
     */
    setSelectedRunners(runnerIds) {
        this.selectedRunners = new Set(runnerIds);

        // Hide markers/trails for deselected runners
        Object.keys(this.markers).forEach(id => {
            const runnerId = parseInt(id);
            if (!this.selectedRunners.has(runnerId)) {
                this._hideRunner(runnerId);
            }
        });
    }

    /**
     * Set camera follow mode
     * @param {string|number} mode - 'all', 'none', or runner ID
     */
    setFollowMode(mode) {
        this.followMode = mode;
    }

    /**
     * Fit map view to show all geofences
     */
    fitToGeofences() {
        if (this.geofenceCircles.length === 0) return;

        const group = L.featureGroup(this.geofenceCircles);
        this.map.fitBounds(group.getBounds(), { padding: [50, 50] });
    }

    /**
     * Fit map view to show all current positions
     */
    fitToPositions() {
        const markers = Object.values(this.markers);
        if (markers.length === 0) return;

        const group = L.featureGroup(markers);
        this.map.fitBounds(group.getBounds(), { padding: [50, 50], maxZoom: 17 });
    }

    /**
     * Clear all trails
     */
    clearTrails() {
        Object.values(this.trails).forEach(trail => trail.setLatLngs([]));
        this.trailPoints = {};
    }

    /**
     * Reset map state (clear markers and trails)
     */
    reset() {
        // Remove all markers
        Object.values(this.markers).forEach(marker => marker.remove());
        this.markers = {};

        // Remove all trails
        Object.values(this.trails).forEach(trail => trail.remove());
        this.trails = {};
        this.trailPoints = {};
    }

    /**
     * Get all runner IDs
     * @returns {Array} Array of runner IDs
     */
    getRunnerIds() {
        return Object.keys(this.runnerData).map(id => parseInt(id));
    }

    /**
     * Get runner info by ID
     * @param {number} runnerId - Runner ID
     * @returns {Object} Runner info object
     */
    getRunner(runnerId) {
        return this.runnerData[runnerId];
    }

    // Private methods

    _updateTrail(runnerId, latLng, color) {
        // Initialize trail points array if needed
        if (!this.trailPoints[runnerId]) {
            this.trailPoints[runnerId] = [];
        }

        // Add new point
        this.trailPoints[runnerId].push(latLng);

        // Limit trail length
        if (this.trailPoints[runnerId].length > this.options.maxTrailLength) {
            this.trailPoints[runnerId].shift();
        }

        // Update or create polyline
        if (this.trails[runnerId]) {
            this.trails[runnerId].setLatLngs(this.trailPoints[runnerId]);
            this.trails[runnerId].setStyle({ opacity: 0.7 });
        } else {
            const trail = L.polyline(this.trailPoints[runnerId], {
                color: color,
                weight: 3,
                opacity: 0.7,
                lineCap: 'round',
                lineJoin: 'round'
            }).addTo(this.map);

            // Ensure trail is below markers
            trail.bringToBack();

            this.trails[runnerId] = trail;
        }
    }

    _hideRunner(runnerId) {
        if (this.markers[runnerId]) {
            this.markers[runnerId].setStyle({ opacity: 0, fillOpacity: 0 });
        }
        if (this.trails[runnerId]) {
            this.trails[runnerId].setStyle({ opacity: 0 });
        }
    }

    _updateCamera(positions) {
        if (positions.length === 0) return;

        if (this.followMode === 'none') {
            // Manual pan, don't auto-update camera
            return;
        }

        if (this.followMode === 'all') {
            // Fit bounds to all visible runners
            const bounds = L.latLngBounds(positions.map(p => [p.lat, p.lon]));

            // Only update if bounds have changed significantly
            if (!this._lastBounds || !this._boundsEqual(bounds, this._lastBounds)) {
                this.map.fitBounds(bounds, {
                    padding: [80, 80],
                    maxZoom: 17,
                    animate: true,
                    duration: 0.5
                });
                this._lastBounds = bounds;
            }
        } else {
            // Follow specific runner
            const runnerPos = positions.find(p => p.runner.id === this.followMode);
            if (runnerPos) {
                this.map.setView([runnerPos.lat, runnerPos.lon], 17, {
                    animate: true,
                    duration: 0.3
                });
            }
        }
    }

    _boundsEqual(a, b) {
        const tolerance = 0.0001;
        const aNE = a.getNorthEast();
        const aSW = a.getSouthWest();
        const bNE = b.getNorthEast();
        const bSW = b.getSouthWest();

        return Math.abs(aNE.lat - bNE.lat) < tolerance &&
               Math.abs(aNE.lng - bNE.lng) < tolerance &&
               Math.abs(aSW.lat - bSW.lat) < tolerance &&
               Math.abs(aSW.lng - bSW.lng) < tolerance;
    }
}

// Export for use in modules or global scope
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ReplayMap;
}
