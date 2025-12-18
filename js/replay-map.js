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
        this.eventLabels = {};       // runnerId -> L.tooltip
        this.geofenceCircles = [];
        this.runnerData = {};        // runnerId -> runner info

        // Follow mode: 'all', 'none', or runner ID (number)
        this.followMode = 'all';
        this.selectedRunners = new Set();

        // Event label timing
        this.eventLabelTimeouts = {};

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
        if (this.geofenceLabels) {
            this.geofenceLabels.forEach(label => label.remove());
        }
        this.geofenceLabels = [];

        // Check if start and finish are at the same location
        const startGf = geofences.find(gf => gf.type === 'start');
        const finishGf = geofences.find(gf => gf.type === 'finish');
        const startFinishCombined = startGf && finishGf &&
            Math.abs(startGf.latitude - finishGf.latitude) < 0.001 &&
            Math.abs(startGf.longitude - finishGf.longitude) < 0.001;

        const processedFinish = false;

        geofences.forEach(gf => {
            const color = this.geofenceColors[gf.type] || '#3b82f6';
            let label = gf.type === 'stage' ? `Stage ${gf.sequence}` :
                        gf.type.charAt(0).toUpperCase() + gf.type.slice(1);

            // Skip finish if combined with start (we'll handle it with start)
            if (gf.type === 'finish' && startFinishCombined) {
                return;
            }

            // Combined Start/Finish label
            if (gf.type === 'start' && startFinishCombined) {
                label = 'Start/Finish';
            }

            if (gf.type === 'stage') {
                // Soft glowing indicator for stages
                // Outer glow layer
                const outerGlow = L.circle([gf.latitude, gf.longitude], {
                    radius: gf.radius * 1.5,
                    color: 'transparent',
                    fillColor: color,
                    fillOpacity: 0.08,
                    weight: 0,
                    className: 'geofence-glow-outer'
                }).addTo(this.map);

                // Inner glow layer
                const innerGlow = L.circle([gf.latitude, gf.longitude], {
                    radius: gf.radius,
                    color: 'transparent',
                    fillColor: color,
                    fillOpacity: 0.15,
                    weight: 0,
                    className: 'geofence-glow-inner'
                }).addTo(this.map);

                // Add permanent label
                const labelMarker = L.marker([gf.latitude, gf.longitude], {
                    icon: L.divIcon({
                        className: 'geofence-label',
                        html: `<span class="geofence-label-text stage-label">${label}</span>`,
                        iconSize: [80, 20],
                        iconAnchor: [40, 10]
                    })
                }).addTo(this.map);

                this.geofenceCircles.push(outerGlow, innerGlow);
                this.geofenceLabels.push(labelMarker);
            } else {
                // Start and Finish - slightly softer but still visible
                const circle = L.circle([gf.latitude, gf.longitude], {
                    radius: gf.radius,
                    color: startFinishCombined ? this.geofenceColors['start'] : color,
                    fillColor: startFinishCombined ? this.geofenceColors['start'] : color,
                    fillOpacity: 0.2,
                    weight: 2,
                    opacity: 0.6
                }).addTo(this.map);

                // Add permanent label for start/finish
                const labelMarker = L.marker([gf.latitude, gf.longitude], {
                    icon: L.divIcon({
                        className: 'geofence-label',
                        html: `<span class="geofence-label-text ${startFinishCombined ? 'start-finish' : gf.type}-label">${label}</span>`,
                        iconSize: [100, 20],
                        iconAnchor: [50, 10]
                    })
                }).addTo(this.map);

                this.geofenceCircles.push(circle);
                this.geofenceLabels.push(labelMarker);
            }
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
     * Load and display the course trail
     * @param {Object} trailData - Trail data object with 'trail' array of [lat, lon] coordinates
     */
    loadTrail(trailData) {
        // Remove existing course trail
        if (this.courseTrailLine) {
            this.courseTrailLine.remove();
            this.courseTrailLine = null;
        }
        if (this.courseTrailGlow) {
            this.courseTrailGlow.remove();
            this.courseTrailGlow = null;
        }

        // Store trail data for off-course detection
        this.courseTrailData = trailData;

        if (!trailData || !trailData.trail || trailData.trail.length === 0) {
            console.log('No trail data to display');
            return;
        }

        console.log(`Loading course trail: ${trailData.trail.length} points from ${trailData.source_runner}`);

        const trailCoords = trailData.trail;

        // Create glow effect (wider, semi-transparent white)
        this.courseTrailGlow = L.polyline(trailCoords, {
            color: '#ffffff',
            weight: 12,
            opacity: 0.25,
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(this.map);

        // Create main trail line (white dashed line)
        this.courseTrailLine = L.polyline(trailCoords, {
            color: '#ffffff',
            weight: 3,
            opacity: 0.8,
            lineCap: 'round',
            lineJoin: 'round',
            dashArray: '12, 8'
        }).addTo(this.map);
    }

    /**
     * Check if a position is off the course trail
     * @param {number} lat - Latitude
     * @param {number} lon - Longitude
     * @param {number} threshold - Distance threshold in meters (default 50m)
     * @returns {boolean} True if position is off course
     */
    isOffCourse(lat, lon, threshold = 50) {
        if (!this.courseTrailData || !this.courseTrailData.trail || this.courseTrailData.trail.length === 0) {
            return false;
        }

        const point = L.latLng(lat, lon);
        let minDistance = Infinity;

        // Find minimum distance to any trail segment
        const trail = this.courseTrailData.trail;
        for (let i = 0; i < trail.length - 1; i++) {
            const segStart = L.latLng(trail[i][0], trail[i][1]);
            const segEnd = L.latLng(trail[i + 1][0], trail[i + 1][1]);

            // Distance to segment (approximate using point-to-line distance)
            const dist = this._pointToSegmentDistance(point, segStart, segEnd);
            if (dist < minDistance) {
                minDistance = dist;
            }
        }

        return minDistance > threshold;
    }

    /**
     * Calculate distance from point to line segment
     * @private
     */
    _pointToSegmentDistance(point, segStart, segEnd) {
        const x = point.lat;
        const y = point.lng;
        const x1 = segStart.lat;
        const y1 = segStart.lng;
        const x2 = segEnd.lat;
        const y2 = segEnd.lng;

        const A = x - x1;
        const B = y - y1;
        const C = x2 - x1;
        const D = y2 - y1;

        const dot = A * C + B * D;
        const lenSq = C * C + D * D;
        let param = -1;

        if (lenSq !== 0) {
            param = dot / lenSq;
        }

        let xx, yy;

        if (param < 0) {
            xx = x1;
            yy = y1;
        } else if (param > 1) {
            xx = x2;
            yy = y2;
        } else {
            xx = x1 + param * C;
            yy = y1 + param * D;
        }

        // Convert lat/lng difference to approximate meters
        // 1 degree lat ≈ 111,000 meters, 1 degree lng varies with latitude
        const latDiff = (x - xx) * 111000;
        const lngDiff = (y - yy) * 111000 * Math.cos(x * Math.PI / 180);

        return Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
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

        // Update event label positions
        this.updateEventLabelPositions();

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
     * Fit map view to position data bounds
     * @param {Array} positions - Array of position frames from data
     */
    fitToPositionData(positions) {
        if (!positions || positions.length === 0) return;

        // Sample positions for faster bounds calculation
        const sampleSize = Math.min(positions.length, 500);
        const step = Math.max(1, Math.floor(positions.length / sampleSize));

        // Collect sampled lat/lon from position data
        const points = [];
        for (let i = 0; i < positions.length; i += step) {
            const frame = positions[i];
            frame.p.forEach(pos => {
                points.push([pos.lat, pos.lon]);
            });
        }

        if (points.length === 0) return;

        const bounds = L.latLngBounds(points);
        this.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
    }

    /**
     * Set initial map view to a specific location
     * @param {number} lat - Latitude
     * @param {number} lon - Longitude
     * @param {number} zoom - Zoom level
     */
    setInitialView(lat, lon, zoom = 15) {
        this.map.setView([lat, lon], zoom);
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

    /**
     * Show an event label on a runner's marker
     * @param {Object} event - Event object with r (runner id) and label
     */
    showEventLabel(event) {
        const runnerId = event.r;

        // Don't show events for hidden runners
        if (!this.selectedRunners.has(runnerId)) return;

        const marker = this.markers[runnerId];
        if (!marker) return;

        // Clear any existing timeout for this runner
        if (this.eventLabelTimeouts[runnerId]) {
            clearTimeout(this.eventLabelTimeouts[runnerId]);
        }

        // Remove existing label
        if (this.eventLabels[runnerId]) {
            this.eventLabels[runnerId].remove();
        }

        // Create new label with event text
        const label = L.tooltip({
            permanent: true,
            direction: 'top',
            offset: [0, -15],
            className: 'event-label'
        })
        .setContent(event.label)
        .setLatLng(marker.getLatLng());

        label.addTo(this.map);
        this.eventLabels[runnerId] = label;

        // Auto-hide after 3 seconds (scaled by playback speed if available)
        this.eventLabelTimeouts[runnerId] = setTimeout(() => {
            if (this.eventLabels[runnerId]) {
                this.eventLabels[runnerId].remove();
                delete this.eventLabels[runnerId];
            }
        }, 3000);
    }

    /**
     * Update event label positions to follow markers
     */
    updateEventLabelPositions() {
        Object.keys(this.eventLabels).forEach(runnerId => {
            const marker = this.markers[runnerId];
            const label = this.eventLabels[runnerId];
            if (marker && label) {
                label.setLatLng(marker.getLatLng());
            }
        });
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
        // Clear any event label for this runner
        if (this.eventLabels[runnerId]) {
            this.eventLabels[runnerId].remove();
            delete this.eventLabels[runnerId];
        }
        if (this.eventLabelTimeouts[runnerId]) {
            clearTimeout(this.eventLabelTimeouts[runnerId]);
            delete this.eventLabelTimeouts[runnerId];
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
