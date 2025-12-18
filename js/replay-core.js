/**
 * ReplayEngine - Core playback engine for race replay
 * Handles data loading, playback state, and timing
 */
class ReplayEngine {
    constructor(options = {}) {
        this.positions = [];
        this.geofences = [];
        this.runners = [];
        this.metadata = {};

        this.currentIndex = 0;
        this.currentTime = 0;
        this.startTime = 0;
        this.endTime = 0;

        this.isPlaying = false;
        this.playbackSpeed = 1;
        this.lastTickTime = 0;
        this.animationFrameId = null;

        // Callbacks
        this.onUpdate = options.onUpdate || (() => {});
        this.onTimeChange = options.onTimeChange || (() => {});
        this.onLoadComplete = options.onLoadComplete || (() => {});

        // Runner positions state (latest known position per runner)
        this.runnerPositions = {};
    }

    /**
     * Load race data from JSON files
     * @param {string} raceId - Race folder name (e.g., 'yoranch', '772/day1')
     */
    async loadData(raceId) {
        try {
            const basePath = `./data/${raceId}`;

            const [positions, geofences, runners, metadata] = await Promise.all([
                fetch(`${basePath}/positions.json`).then(r => r.json()),
                fetch(`${basePath}/geofences.json`).then(r => r.json()),
                fetch(`${basePath}/runners.json`).then(r => r.json()),
                fetch(`${basePath}/metadata.json`).then(r => r.json())
            ]);

            this.positions = positions;
            this.geofences = geofences;
            this.runners = runners;
            this.metadata = metadata;

            this.startTime = metadata.startTime;
            this.endTime = metadata.endTime;
            this.currentTime = this.startTime;
            this.currentIndex = 0;
            this.runnerPositions = {};

            // Create runner lookup map
            this.runnerMap = {};
            runners.forEach(r => {
                this.runnerMap[r.id] = r;
            });

            this.onLoadComplete({
                positions: this.positions,
                geofences: this.geofences,
                runners: this.runners,
                metadata: this.metadata
            });

            return {
                positions: this.positions,
                geofences: this.geofences,
                runners: this.runners,
                metadata: this.metadata
            };
        } catch (error) {
            console.error('Failed to load race data:', error);
            throw error;
        }
    }

    /**
     * Start playback
     */
    play() {
        if (this.isPlaying) return;

        this.isPlaying = true;
        this.lastTickTime = performance.now();
        this._tick();
    }

    /**
     * Pause playback
     */
    pause() {
        this.isPlaying = false;
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
    }

    /**
     * Toggle play/pause
     */
    toggle() {
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play();
        }
        return this.isPlaying;
    }

    /**
     * Set playback speed multiplier
     * @param {number} speed - Speed multiplier (1, 2, 5, 10, 30, etc.)
     */
    setSpeed(speed) {
        this.playbackSpeed = speed;
    }

    /**
     * Seek to a specific timestamp
     * @param {number} timestamp - Unix timestamp to seek to
     */
    seekToTime(timestamp) {
        this.currentTime = Math.max(this.startTime, Math.min(this.endTime, timestamp));
        this._rebuildStateAtTime(this.currentTime);
        this._notifyUpdate();
    }

    /**
     * Seek to a percentage of the race
     * @param {number} percent - Percentage (0-1)
     */
    seekToPercent(percent) {
        const duration = this.endTime - this.startTime;
        const timestamp = this.startTime + (duration * percent);
        this.seekToTime(timestamp);
    }

    /**
     * Get current progress as percentage
     * @returns {number} Progress 0-1
     */
    getProgress() {
        const duration = this.endTime - this.startTime;
        if (duration === 0) return 0;
        return (this.currentTime - this.startTime) / duration;
    }

    /**
     * Get duration in seconds
     * @returns {number} Duration in seconds
     */
    getDuration() {
        return this.endTime - this.startTime;
    }

    /**
     * Format timestamp as HH:MM:SS
     * @param {number} timestamp - Unix timestamp
     * @returns {string} Formatted time string
     */
    formatTime(timestamp) {
        const date = new Date(timestamp * 1000);
        return date.toLocaleTimeString('en-US', { hour12: false });
    }

    /**
     * Format elapsed time as HH:MM:SS
     * @param {number} seconds - Seconds elapsed
     * @returns {string} Formatted duration string
     */
    formatDuration(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    /**
     * Get current runner positions
     * @returns {Array} Array of position objects with runner info
     */
    getCurrentPositions() {
        return Object.values(this.runnerPositions).map(pos => ({
            ...pos,
            runner: this.runnerMap[pos.r]
        }));
    }

    // Private methods

    _tick() {
        if (!this.isPlaying) return;

        const now = performance.now();
        const deltaMs = now - this.lastTickTime;
        this.lastTickTime = now;

        // Advance time based on playback speed
        // deltaMs is real time, multiply by speed to get simulated time
        const deltaSeconds = (deltaMs / 1000) * this.playbackSpeed;
        this.currentTime += deltaSeconds;

        // Check if we've reached the end
        if (this.currentTime >= this.endTime) {
            this.currentTime = this.endTime;
            this.isPlaying = false;
            this._updateToCurrentTime();
            this.onTimeChange(this.currentTime, this.getProgress(), false);
            return;
        }

        this._updateToCurrentTime();
        this.onTimeChange(this.currentTime, this.getProgress(), true);

        this.animationFrameId = requestAnimationFrame(() => this._tick());
    }

    _updateToCurrentTime() {
        // Find all position frames up to current time
        while (this.currentIndex < this.positions.length &&
               this.positions[this.currentIndex].t <= this.currentTime) {
            const frame = this.positions[this.currentIndex];

            // Update runner positions from this frame
            for (const pos of frame.p) {
                this.runnerPositions[pos.r] = {
                    ...pos,
                    timestamp: frame.t
                };
            }

            this.currentIndex++;
        }

        this._notifyUpdate();
    }

    _rebuildStateAtTime(timestamp) {
        // Reset state and rebuild from beginning
        this.runnerPositions = {};
        this.currentIndex = 0;

        // Find the right index and rebuild state
        while (this.currentIndex < this.positions.length &&
               this.positions[this.currentIndex].t <= timestamp) {
            const frame = this.positions[this.currentIndex];

            for (const pos of frame.p) {
                this.runnerPositions[pos.r] = {
                    ...pos,
                    timestamp: frame.t
                };
            }

            this.currentIndex++;
        }
    }

    _notifyUpdate() {
        const positions = this.getCurrentPositions();
        this.onUpdate(positions, this.currentTime);
    }
}

// Export for use in modules or global scope
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ReplayEngine;
}
