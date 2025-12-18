/**
 * ReplayEngine - Core playback engine for race replay
 * Handles data loading, playback state, timing, and scoring
 * Uses pre-calculated scoring data from database
 */
class ReplayEngine {
    constructor(options = {}) {
        this.positions = [];
        this.geofences = [];
        this.runners = [];
        this.scoring = [];      // Pre-calculated scoring data
        this.events = [];       // Generated from scoring timestamps
        this.metadata = {};

        this.currentIndex = 0;
        this.currentEventIndex = 0;
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
        this.onEvent = options.onEvent || (() => {});
        this.onScoreUpdate = options.onScoreUpdate || (() => {});

        // Runner positions state (latest known position per runner)
        this.runnerPositions = {};

        // Scoring state per runner (tracks what has been shown/processed)
        this.scoringState = {};  // runner_id -> {hasStarted, hasFinished, stagesEntered: Set, stagesExited: Set}
    }

    /**
     * Load race data from JSON files
     * @param {string} raceId - Race folder name (e.g., 'yoranch', '772/day1')
     */
    async loadData(raceId) {
        try {
            const basePath = `./data/${raceId}`;

            const [positions, geofences, runners, metadata, scoring] = await Promise.all([
                fetch(`${basePath}/positions.json`).then(r => r.json()),
                fetch(`${basePath}/geofences.json`).then(r => r.json()),
                fetch(`${basePath}/runners.json`).then(r => r.json()),
                fetch(`${basePath}/metadata.json`).then(r => r.json()),
                fetch(`${basePath}/scoring.json`).then(r => r.json())
            ]);

            this.positions = positions;
            this.geofences = geofences;
            this.runners = runners;
            this.scoring = scoring;
            this.metadata = metadata;

            this.startTime = metadata.startTime;
            this.endTime = metadata.endTime;
            this.currentTime = this.startTime;
            this.currentIndex = 0;
            this.currentEventIndex = 0;
            this.runnerPositions = {};

            // Create runner lookup map
            this.runnerMap = {};
            runners.forEach(r => {
                this.runnerMap[r.id] = r;
            });

            // Create scoring lookup map
            this.scoringMap = {};
            scoring.forEach(s => {
                this.scoringMap[s.runner_id] = s;
            });

            // Count stages for display
            this.totalStages = metadata.totalStages || geofences.filter(gf => gf.type === 'stage').length;

            // Generate events from scoring timestamps for map labels
            this.events = this._generateEventsFromScoring(scoring);
            this.events.sort((a, b) => a.t - b.t);

            // Initialize scoring state (what has been shown so far)
            this._resetScoringState();

            this.onLoadComplete({
                positions: this.positions,
                geofences: this.geofences,
                runners: this.runners,
                scoring: this.scoring,
                metadata: this.metadata
            });

            return {
                positions: this.positions,
                geofences: this.geofences,
                runners: this.runners,
                scoring: this.scoring,
                metadata: this.metadata
            };
        } catch (error) {
            console.error('Failed to load race data:', error);
            throw error;
        }
    }

    /**
     * Generate events from scoring timestamps for map labels
     */
    _generateEventsFromScoring(scoring) {
        const events = [];

        scoring.forEach(s => {
            const runnerId = s.runner_id;

            // Exit start event
            if (s.exited_start) {
                events.push({
                    t: s.exited_start,
                    r: runnerId,
                    label: 'Start!',
                    type: 'exit_start'
                });
            }

            // Stage events
            if (s.stage_timestamps) {
                Object.entries(s.stage_timestamps).forEach(([stageNum, times]) => {
                    if (times.enter) {
                        events.push({
                            t: times.enter,
                            r: runnerId,
                            label: `Stage ${stageNum}`,
                            type: 'enter_stage',
                            stage: parseInt(stageNum)
                        });
                    }
                    if (times.exit) {
                        events.push({
                            t: times.exit,
                            r: runnerId,
                            label: `Exit S${stageNum}`,
                            type: 'exit_stage',
                            stage: parseInt(stageNum)
                        });
                    }
                });
            }

            // Finish event
            if (s.enter_finish) {
                events.push({
                    t: s.enter_finish,
                    r: runnerId,
                    label: 'Finish!',
                    type: 'enter_finish'
                });
            }
        });

        return events;
    }

    /**
     * Reset scoring state for all runners
     */
    _resetScoringState() {
        this.scoringState = {};
        this.runners.forEach(r => {
            this.scoringState[r.id] = {
                hasStarted: false,
                hasFinished: false,
                stagesEntered: new Set(),
                stagesExited: new Set()
            };
        });
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
        this.onScoreUpdate(this.getScores());
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

    /**
     * Get current scores for all runners
     * Uses pre-calculated scoring data with stage dwell time subtracted
     * @returns {Array} Array of score objects
     */
    getScores() {
        return this.runners.map(runner => {
            const scoringData = this.scoringMap[runner.id];
            const state = this.scoringState[runner.id];

            if (!scoringData) {
                return {
                    runner: runner,
                    stages: 0,
                    totalStages: this.totalStages,
                    hasStarted: false,
                    hasFinished: false,
                    elapsedTime: null
                };
            }

            // Check current state based on time
            const hasStarted = scoringData.exited_start && this.currentTime >= scoringData.exited_start;
            const hasFinished = scoringData.enter_finish && this.currentTime >= scoringData.enter_finish;

            // Count completed stages at current time
            let stagesCompleted = 0;
            let stageDwellTime = 0;

            if (scoringData.stage_timestamps) {
                Object.entries(scoringData.stage_timestamps).forEach(([stageNum, times]) => {
                    if (times.enter && times.exit) {
                        // Stage fully completed before current time
                        if (this.currentTime >= times.exit) {
                            stagesCompleted++;
                            stageDwellTime += (times.exit - times.enter);
                        }
                        // Currently in stage
                        else if (this.currentTime >= times.enter) {
                            stageDwellTime += (this.currentTime - times.enter);
                        }
                    }
                });
            }

            // Calculate elapsed time with stage dwell subtracted
            let elapsedTime = null;
            if (hasStarted) {
                if (hasFinished) {
                    // Use pre-calculated total_run_time for finished runners
                    elapsedTime = scoringData.total_run_time;
                } else {
                    // Calculate current adjusted time: (current - start) - stage_dwell
                    const rawElapsed = this.currentTime - scoringData.exited_start;
                    elapsedTime = rawElapsed - stageDwellTime;
                }
            }

            return {
                runner: runner,
                stages: stagesCompleted,
                totalStages: scoringData.total_stages || this.totalStages,
                hasStarted: hasStarted,
                hasFinished: hasFinished,
                elapsedTime: elapsedTime
            };
        });
    }

    // Private methods

    _tick() {
        if (!this.isPlaying) return;

        const now = performance.now();
        const deltaMs = now - this.lastTickTime;
        this.lastTickTime = now;

        // Advance time based on playback speed
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
        // Process position frames
        while (this.currentIndex < this.positions.length &&
               this.positions[this.currentIndex].t <= this.currentTime) {
            const frame = this.positions[this.currentIndex];

            for (const pos of frame.p) {
                this.runnerPositions[pos.r] = {
                    ...pos,
                    timestamp: frame.t
                };
            }

            this.currentIndex++;
        }

        // Process events
        const newEvents = [];
        while (this.currentEventIndex < this.events.length &&
               this.events[this.currentEventIndex].t <= this.currentTime) {
            const event = this.events[this.currentEventIndex];
            this._processEvent(event);
            newEvents.push(event);
            this.currentEventIndex++;
        }

        // Notify about new events (for map labels)
        if (newEvents.length > 0) {
            newEvents.forEach(e => this.onEvent(e));
        }

        // Always update scores (elapsed time changes continuously)
        this.onScoreUpdate(this.getScores());

        this._notifyUpdate();
    }

    _processEvent(event) {
        const state = this.scoringState[event.r];
        if (!state) return;

        // Update scoring state for tracking which events have been shown
        if (event.type === 'exit_start') {
            state.hasStarted = true;
        } else if (event.type === 'enter_finish') {
            state.hasFinished = true;
        } else if (event.type === 'enter_stage') {
            state.stagesEntered.add(event.stage);
        } else if (event.type === 'exit_stage') {
            state.stagesExited.add(event.stage);
        }
    }

    _rebuildStateAtTime(timestamp) {
        // Reset state and rebuild from beginning
        this.runnerPositions = {};
        this.currentIndex = 0;
        this.currentEventIndex = 0;

        // Reset scoring state
        this._resetScoringState();

        // Rebuild positions
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

        // Rebuild event state (for tracking which events have been shown)
        while (this.currentEventIndex < this.events.length &&
               this.events[this.currentEventIndex].t <= timestamp) {
            const event = this.events[this.currentEventIndex];
            this._processEvent(event);
            this.currentEventIndex++;
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
