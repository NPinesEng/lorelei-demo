/**
 * ReplayControls - UI controls for race replay
 * Handles play/pause, speed, timeline, and runner selection
 */
class ReplayControls {
    constructor(containerId, engine, map) {
        this.container = document.getElementById(containerId);
        this.engine = engine;
        this.map = map;

        this._render();
        this._bindEvents();
        this._setupEngineCallbacks();
    }

    /**
     * Load runner data into controls
     * @param {Array} runners - Array of runner objects
     */
    loadRunners(runners) {
        // Add runners to follow dropdown
        const followSelect = document.getElementById('follow-select');
        runners.forEach(runner => {
            const option = document.createElement('option');
            option.value = runner.id;
            option.textContent = runner.name;
            followSelect.appendChild(option);
        });

        // Add runner checkboxes
        const checkboxContainer = document.getElementById('runner-checkboxes');
        checkboxContainer.innerHTML = '';

        runners.forEach(runner => {
            const label = document.createElement('label');
            label.className = 'runner-checkbox';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = runner.id;
            checkbox.checked = true;
            checkbox.addEventListener('change', () => this._updateSelectedRunners());

            const colorDot = document.createElement('span');
            colorDot.className = 'runner-color-dot';
            colorDot.style.backgroundColor = runner.color;

            const nameSpan = document.createElement('span');
            nameSpan.textContent = runner.name;

            label.appendChild(checkbox);
            label.appendChild(colorDot);
            label.appendChild(nameSpan);
            checkboxContainer.appendChild(label);
        });
    }

    /**
     * Update metadata display
     * @param {Object} metadata - Race metadata
     */
    updateMetadata(metadata) {
        const raceInfo = document.getElementById('race-info');
        if (raceInfo) {
            raceInfo.textContent = `${metadata.runnerCount} runners`;
        }
    }

    // Private methods

    _render() {
        this.container.innerHTML = `
            <div class="replay-controls">
                <div class="controls-main">
                    <div class="controls-row controls-playback">
                        <button id="play-btn" class="control-btn play-btn" title="Play/Pause">
                            <svg class="icon-play" viewBox="0 0 24 24" width="24" height="24">
                                <polygon points="5,3 19,12 5,21" fill="currentColor"/>
                            </svg>
                            <svg class="icon-pause" viewBox="0 0 24 24" width="24" height="24" style="display:none;">
                                <rect x="6" y="4" width="4" height="16" fill="currentColor"/>
                                <rect x="14" y="4" width="4" height="16" fill="currentColor"/>
                            </svg>
                        </button>

                        <div class="speed-control">
                            <label for="speed-select">Speed:</label>
                            <select id="speed-select" class="control-select">
                                <option value="1">1x</option>
                                <option value="2">2x</option>
                                <option value="5">5x</option>
                                <option value="10" selected>10x</option>
                                <option value="30">30x</option>
                                <option value="60">60x</option>
                            </select>
                        </div>

                        <div class="time-display">
                            <span id="current-time" class="time-value">00:00:00</span>
                            <span class="time-separator">/</span>
                            <span id="end-time" class="time-value">00:00:00</span>
                        </div>

                        <div class="elapsed-display">
                            <span class="elapsed-label">Elapsed:</span>
                            <span id="elapsed-time" class="elapsed-value">00:00:00</span>
                        </div>
                    </div>

                    <div class="controls-row controls-timeline">
                        <input type="range" id="timeline-slider" class="timeline-slider"
                               min="0" max="1000" value="0" step="1">
                    </div>
                </div>

                <div class="controls-secondary">
                    <div class="follow-control">
                        <label for="follow-select">Camera:</label>
                        <select id="follow-select" class="control-select">
                            <option value="all">Follow All</option>
                            <option value="none">Manual</option>
                        </select>
                    </div>

                    <div class="runner-filter">
                        <span class="filter-label">Runners:</span>
                        <div id="runner-checkboxes" class="runner-checkboxes"></div>
                    </div>
                </div>
            </div>
        `;
    }

    _bindEvents() {
        // Play/Pause button
        document.getElementById('play-btn').addEventListener('click', () => {
            const isPlaying = this.engine.toggle();
            this._updatePlayButton(isPlaying);
        });

        // Speed control
        document.getElementById('speed-select').addEventListener('change', (e) => {
            this.engine.setSpeed(parseInt(e.target.value));
        });

        // Set initial speed
        this.engine.setSpeed(10);

        // Timeline slider
        const slider = document.getElementById('timeline-slider');
        let isDragging = false;

        slider.addEventListener('mousedown', () => {
            isDragging = true;
            this.engine.pause();
            this._updatePlayButton(false);
        });

        slider.addEventListener('input', (e) => {
            if (isDragging) {
                const percent = parseFloat(e.target.value) / 1000;
                this.engine.seekToPercent(percent);
            }
        });

        slider.addEventListener('mouseup', () => {
            isDragging = false;
        });

        slider.addEventListener('change', (e) => {
            const percent = parseFloat(e.target.value) / 1000;
            this.engine.seekToPercent(percent);
            isDragging = false;
        });

        // Follow mode
        document.getElementById('follow-select').addEventListener('change', (e) => {
            const value = e.target.value;
            if (value === 'all' || value === 'none') {
                this.map.setFollowMode(value);
            } else {
                this.map.setFollowMode(parseInt(value));
            }
        });
    }

    _setupEngineCallbacks() {
        // Update time display when time changes
        this.engine.onTimeChange = (time, progress, isPlaying) => {
            this._updateTimeDisplay(time, progress);

            // Update play button if playback ended
            if (!isPlaying && this.engine.currentTime >= this.engine.endTime) {
                this._updatePlayButton(false);
            }
        };
    }

    _updateSelectedRunners() {
        const checkboxes = document.querySelectorAll('#runner-checkboxes input:checked');
        const selected = Array.from(checkboxes).map(cb => parseInt(cb.value));
        this.map.setSelectedRunners(selected);
    }

    _updatePlayButton(isPlaying) {
        const playIcon = document.querySelector('.icon-play');
        const pauseIcon = document.querySelector('.icon-pause');

        if (isPlaying) {
            playIcon.style.display = 'none';
            pauseIcon.style.display = 'block';
        } else {
            playIcon.style.display = 'block';
            pauseIcon.style.display = 'none';
        }
    }

    _updateTimeDisplay(timestamp, progress) {
        // Update current time
        const currentTimeEl = document.getElementById('current-time');
        currentTimeEl.textContent = this.engine.formatTime(timestamp);

        // Update end time (only needs to be set once, but keeping it simple)
        const endTimeEl = document.getElementById('end-time');
        endTimeEl.textContent = this.engine.formatTime(this.engine.endTime);

        // Update elapsed time
        const elapsedSeconds = timestamp - this.engine.startTime;
        const elapsedEl = document.getElementById('elapsed-time');
        elapsedEl.textContent = this.engine.formatDuration(elapsedSeconds);

        // Update slider (avoid feedback loop by checking if it's being dragged)
        const slider = document.getElementById('timeline-slider');
        if (document.activeElement !== slider) {
            slider.value = Math.round(progress * 1000);
        }
    }
}

// Export for use in modules or global scope
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ReplayControls;
}
