const GREYSCALE_STOPS = [
    [32, 33, 36],
    [78, 82, 87],
    [128, 132, 138],
    [184, 188, 194],
    [232, 235, 239]
];

const TRACK_ROLE_COLORS = {
    origin: [92, 141, 255],
    predicted: [255, 160, 84],
    next: [172, 130, 255],
    left: [90, 150, 255],
    right: [255, 110, 170],
    pivot: [255, 190, 92],
    min: [55, 185, 145],
    max: [255, 88, 116],
    scan: [178, 128, 255],
    anchor: [112, 203, 95],
    key: [255, 145, 110],
    write: [255, 122, 74],
    current: [0, 188, 212],
    compare: [120, 175, 255]
};

const ROLE_LABELS = {
    origin: 'Origin',
    predicted: 'Predicted Index',
    next: 'Step Toward Gap',
    left: 'Left Compare',
    right: 'Right Compare',
    pivot: 'Pivot',
    min: 'Min',
    max: 'Max',
    scan: 'Scan/Index Check',
    anchor: 'Anchor',
    key: 'Key',
    write: 'Write',
    current: 'Current',
    compare: 'Compare'
};

const ROLE_DISPLAY_ORDER = [
    'origin', 'predicted', 'next', 'scan', 'left', 'right', 'pivot',
    'min', 'max', 'anchor', 'key', 'write', 'current', 'compare'
];

const SORT_RUN_TIMEOUT_MS = 1200;
const SORT_RUN_MAX_TICKS = 250000;

function clampChannel(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}

function interpolateRgb(stops, t) {
    if (t <= 0) {
        return [...stops[0]];
    }
    if (t >= 1) {
        return [...stops[stops.length - 1]];
    }

    const scaled = t * (stops.length - 1);
    const index = Math.floor(scaled);
    const localT = scaled - index;
    const start = stops[index];
    const end = stops[index + 1];

    return [
        clampChannel(start[0] + (end[0] - start[0]) * localT),
        clampChannel(start[1] + (end[1] - start[1]) * localT),
        clampChannel(start[2] + (end[2] - start[2]) * localT)
    ];
}

function mixRgb(base, overlay, alpha) {
    return [
        clampChannel(base[0] * (1 - alpha) + overlay[0] * alpha),
        clampChannel(base[1] * (1 - alpha) + overlay[1] * alpha),
        clampChannel(base[2] * (1 - alpha) + overlay[2] * alpha)
    ];
}

function rgbToString(rgb) {
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function getGreyscaleRgb(value, maxValue) {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return [241, 245, 249];
    }
    const t = maxValue <= 1 ? 0 : (value - 1) / (maxValue - 1);
    return interpolateRgb(GREYSCALE_STOPS, t);
}

function getTextRgb(baseRgb) {
    const luminance = 0.2126 * baseRgb[0] + 0.7152 * baseRgb[1] + 0.0722 * baseRgb[2];
    const delta = luminance > 145 ? -28 : 32;

    return [
        clampChannel(baseRgb[0] + delta),
        clampChannel(baseRgb[1] + delta),
        clampChannel(baseRgb[2] + delta)
    ];
}

function getCellPalette(value, maxValue, roles = []) {
    const baseRgb = getGreyscaleRgb(value, maxValue);
    let fillRgb = [...baseRgb];

    roles.forEach((role) => {
        const overlayRgb = TRACK_ROLE_COLORS[role] || TRACK_ROLE_COLORS.compare;
        fillRgb = mixRgb(fillRgb, overlayRgb, 0.34);
    });

    return {
        background: rgbToString(fillRgb),
        text: rgbToString(getTextRgb(fillRgb))
    };
}

function getLegendPalette(role) {
    const overlayRgb = TRACK_ROLE_COLORS[role] || TRACK_ROLE_COLORS.compare;
    const fillRgb = mixRgb([248, 250, 252], overlayRgb, 0.68);
    return {
        background: rgbToString(fillRgb),
        text: rgbToString(getTextRgb(fillRgb))
    };
}

class SortSimulator {
    constructor(index, onRemove, onAlgorithmChange) {
        this.index = index;
        this.onRemove = onRemove;
        this.onAlgorithmChange = onAlgorithmChange;
        this.root = this.createMarkup();
        this.cacheElements();
        this.setupEventListeners();
    }

    createMarkup() {
        const card = document.createElement('article');
        card.className = 'simulator-card';
        card.innerHTML = `
            <div class="simulator-header">
                <div class="controls">
                    <select class="algorithm-select" aria-label="Sorting algorithm">
                        <option value="bubble">Bubble Sort</option>
                        <option value="selection">Selection Sort</option>
                        <option value="insertion">Insertion Sort</option>
                        <option value="merge">Merge Sort</option>
                        <option value="quick">Quick Sort</option>
                        <option value="prediction">Prediction Sort</option>
                    </select>
                    <div class="trace-range-controls">
                        <span class="trace-range-label">Rows</span>
                        <input class="trace-range-input trace-range-start" type="number" min="0" placeholder="from" aria-label="Copy trace from row">
                        <span class="trace-range-sep">-</span>
                        <input class="trace-range-input trace-range-end" type="number" min="0" placeholder="to" aria-label="Copy trace to row">
                    </div>
                    <button class="copy-trace-btn" type="button">Copy Trace</button>
                </div>
                <button class="remove-btn" type="button">Remove</button>
            </div>

            <div class="legend-bar"></div>

            <div class="visualization-area">
                <div class="grid-container"></div>
            </div>

            <div class="stats-bar">
                <span class="stat-pill">Comparisons: <strong class="stat-comparisons">0</strong></span>
                <span class="stat-pill">Index Checks: <strong class="stat-index-checks">0</strong></span>
                <span class="stat-pill">Swaps: <strong class="stat-swaps">0</strong></span>
            </div>

            <div class="code-display">
                <h3>Algorithm Code</h3>
                <pre class="code-output"></pre>
            </div>
        `;
        return card;
    }

    cacheElements() {
        this.algorithmSelect = this.root.querySelector('.algorithm-select');
        this.traceRangeStart = this.root.querySelector('.trace-range-start');
        this.traceRangeEnd = this.root.querySelector('.trace-range-end');
        this.copyTraceBtn = this.root.querySelector('.copy-trace-btn');
        this.removeBtn = this.root.querySelector('.remove-btn');
        this.legendBar = this.root.querySelector('.legend-bar');
        this.visualizationArea = this.root.querySelector('.visualization-area');
        this.gridContainer = this.root.querySelector('.grid-container');
        this.statsComparisons = this.root.querySelector('.stat-comparisons');
        this.statsIndexChecks = this.root.querySelector('.stat-index-checks');
        this.statsSwaps = this.root.querySelector('.stat-swaps');
        this.codeOutput = this.root.querySelector('.code-output');
    }

    setupEventListeners() {
        this.algorithmSelect.addEventListener('change', () => this.onAlgorithmChange());
        this.copyTraceBtn.addEventListener('click', () => this.copyTrace());
        this.removeBtn.addEventListener('click', () => this.onRemove(this));
    }

    buildTraceExport(startRow = null, endRow = null) {
        if (!this.lastRun) {
            return '';
        }

        const { algorithmName, inputList, steps, stats } = this.lastRun;
        const lines = [];
        lines.push('SORTLAB_TRACE_V1');
        lines.push(`algorithm=${algorithmName}`);
        lines.push(`input=${inputList.join(',')}`);
        lines.push(`comparisons=${stats.comparisons ?? 0}`);
        lines.push(`indexChecks=${stats.indexChecks ?? 0}`);
        lines.push(`swaps=${stats.swaps ?? 0}`);
        lines.push('row|cmp|chk|swp|values|written');

        steps.forEach((step, row) => {
            if (startRow !== null && row < startRow) {
                return;
            }
            if (endRow !== null && row > endRow) {
                return;
            }

            const snapshot = step.statsSnapshot || {};
            const cmp = snapshot.comparisons ?? '';
            const chk = snapshot.indexChecks ?? '';
            const swp = snapshot.swaps ?? '';
            const values = Array.isArray(step.values) ? step.values.join(',') : '';
            const written = Array.isArray(step.writtenValues)
                ? step.writtenValues.map((isWritten) => (isWritten ? '1' : '0')).join('')
                : '';
            lines.push(`${row}|${cmp}|${chk}|${swp}|${values}|${written}`);
        });

        return lines.join('\n');
    }

    flashCopyStatus(label) {
        const original = this.copyTraceBtn.textContent;
        this.copyTraceBtn.textContent = label;
        window.setTimeout(() => {
            this.copyTraceBtn.textContent = original;
        }, 900);
    }

    fallbackCopyText(text) {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.setAttribute('readonly', 'readonly');
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        textArea.style.pointerEvents = 'none';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);

        textArea.focus();
        textArea.select();
        textArea.setSelectionRange(0, textArea.value.length);

        let copied = false;
        try {
            copied = document.execCommand('copy');
        } catch (error) {
            copied = false;
        }

        document.body.removeChild(textArea);
        return copied;
    }

    async copyTrace() {
        const startRaw = this.traceRangeStart.value.trim();
        const endRaw = this.traceRangeEnd.value.trim();
        let startRow = startRaw === '' ? null : Number.parseInt(startRaw, 10);
        let endRow = endRaw === '' ? null : Number.parseInt(endRaw, 10);

        if (Number.isNaN(startRow)) {
            startRow = null;
        }
        if (Number.isNaN(endRow)) {
            endRow = null;
        }

        if (startRow !== null && endRow !== null && startRow > endRow) {
            const tmp = startRow;
            startRow = endRow;
            endRow = tmp;
        }

        const text = this.buildTraceExport(startRow, endRow);
        if (!text) {
            this.flashCopyStatus('No Trace');
            return;
        }

        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                this.flashCopyStatus('Copied');
                return;
            }

            const copied = this.fallbackCopyText(text);
            this.flashCopyStatus(copied ? 'Copied' : 'Copy Failed');
        } catch (error) {
            const copied = this.fallbackCopyText(text);
            this.flashCopyStatus(copied ? 'Copied' : 'Copy Failed');
        }
    }

    renderGrid(steps, colorMaxValue) {
        this.gridContainer.innerHTML = '';
        const hasOpColumns = steps.some((step) => step.statsSnapshot !== undefined);
        const hasAuxLane = steps.some((step) => Array.isArray(step.auxValues));
        const hasCarryLane = steps.some((step) => step.carryValue !== undefined);
        const hasVariableLane = steps.some((step) => step.minValue !== undefined || step.maxValue !== undefined);

        let template = `repeat(${steps[0].values.length}, minmax(0, 1fr))`;

        if (hasOpColumns) {
            template = 'minmax(40px, 40px) minmax(40px, 40px) minmax(44px, 44px) minmax(40px, 40px) 10px ' + template;
        }

        if (hasAuxLane) {
            template += ` 10px repeat(${steps[0].values.length}, minmax(0, 1fr))`;
        }

        if (hasCarryLane) {
            template += ' 10px minmax(34px, 34px)';
        }

        if (hasVariableLane) {
            template += ' 10px minmax(34px, 34px) minmax(34px, 34px)';
        }

        const headerRow = document.createElement('div');
        headerRow.className = 'grid-row header-row';
        headerRow.style.gridTemplateColumns = template;

        if (hasOpColumns) {
            ['Row', 'Cmp', 'Chk', 'Swp'].forEach((label) => {
                const headerCell = document.createElement('div');
                headerCell.className = 'item op-item header-item';
                headerCell.textContent = label;
                headerRow.appendChild(headerCell);
            });

            const divider = document.createElement('div');
            divider.className = 'lane-divider';
            headerRow.appendChild(divider);
        }

        for (let i = 0; i < steps[0].values.length; i++) {
            const headerCell = document.createElement('div');
            headerCell.className = 'item header-item';
            headerCell.textContent = i;
            headerRow.appendChild(headerCell);
        }

        if (hasAuxLane) {
            const divider = document.createElement('div');
            divider.className = 'lane-divider';
            headerRow.appendChild(divider);

            for (let i = 0; i < steps[0].values.length; i++) {
                const headerCell = document.createElement('div');
                headerCell.className = 'item header-item';
                headerCell.textContent = `a${i}`;
                headerRow.appendChild(headerCell);
            }
        }

        if (hasCarryLane) {
            const divider = document.createElement('div');
            divider.className = 'lane-divider';
            headerRow.appendChild(divider);

            const carryHeader = document.createElement('div');
            carryHeader.className = 'item header-item';
            carryHeader.textContent = 'C';
            headerRow.appendChild(carryHeader);
        }

        if (hasVariableLane) {
            const divider = document.createElement('div');
            divider.className = 'lane-divider';
            headerRow.appendChild(divider);

            const minHeader = document.createElement('div');
            minHeader.className = 'item header-item';
            minHeader.textContent = 'Min';
            headerRow.appendChild(minHeader);

            const maxHeader = document.createElement('div');
            maxHeader.className = 'item header-item';
            maxHeader.textContent = 'Max';
            headerRow.appendChild(maxHeader);
        }

        this.gridContainer.appendChild(headerRow);

        steps.forEach((step, stepIndex) => {
            const row = document.createElement('div');
            row.className = 'grid-row';
            row.style.gridTemplateColumns = template;

            const rolesByLane = {
                main: new Map(),
                aux: new Map(),
                carry: new Map(),
                vars: new Map()
            };

            (step.trackedIndices || []).forEach(({ index, role, lane }) => {
                const laneKey = lane === 'aux'
                    ? 'aux'
                    : lane === 'carry'
                        ? 'carry'
                        : lane === 'vars'
                            ? 'vars'
                            : 'main';
                if (!rolesByLane[laneKey].has(index)) {
                    rolesByLane[laneKey].set(index, []);
                }
                rolesByLane[laneKey].get(index).push(role);
            });

            if (hasOpColumns) {
                const stats = step.statsSnapshot || { comparisons: 0, indexChecks: 0, swaps: 0 };
                const opValues = [stepIndex, stats.comparisons, stats.indexChecks, stats.swaps];
                opValues.forEach((value) => {
                    const opCell = document.createElement('div');
                    opCell.className = 'item op-item';
                    opCell.textContent = String(value);
                    row.appendChild(opCell);
                });

                const divider = document.createElement('div');
                divider.className = 'lane-divider';
                row.appendChild(divider);
            }

            step.values.forEach((value, index) => {
                const item = document.createElement('div');
                item.className = 'item';
                const roles = rolesByLane.main.get(index) || [];
                const isWritten = Array.isArray(step.writtenValues) ? Boolean(step.writtenValues[index]) : false;
                if (value === null || value === undefined) {
                    item.classList.add('empty-item');
                    item.textContent = '';
                } else {
                    const palette = getCellPalette(value, colorMaxValue, roles);
                    item.style.backgroundColor = palette.background;
                    item.style.color = palette.text;
                    item.textContent = value;
                }

                if (roles.length > 0) {
                    item.classList.add('tracked-cell');
                }

                if (isWritten) {
                    item.classList.add('written-index');
                }

                row.appendChild(item);
            });

            if (hasAuxLane) {
                const divider = document.createElement('div');
                divider.className = 'lane-divider';
                row.appendChild(divider);

                const auxValues = Array.isArray(step.auxValues)
                    ? step.auxValues
                    : new Array(step.values.length).fill(null);

                auxValues.forEach((value, index) => {
                    const item = document.createElement('div');
                    item.className = 'item aux-item';

                    if (value === null || value === undefined) {
                        item.classList.add('empty-item');
                        item.textContent = '';
                    } else {
                        const roles = rolesByLane.aux.get(index) || [];
                        const palette = getCellPalette(value, colorMaxValue, roles);
                        item.style.backgroundColor = palette.background;
                        item.style.color = palette.text;
                        item.textContent = value;
                        if (roles.length > 0) {
                            item.classList.add('tracked-cell');
                        }
                    }

                    row.appendChild(item);
                });
            }

            if (hasCarryLane) {
                const divider = document.createElement('div');
                divider.className = 'lane-divider';
                row.appendChild(divider);

                const carryItem = document.createElement('div');
                carryItem.className = 'item carry-item';
                const carryValue = step.carryValue;

                if (carryValue === null || carryValue === undefined) {
                    carryItem.classList.add('empty-item');
                    carryItem.textContent = '';
                } else {
                    const roles = rolesByLane.carry.get(0) || [];
                    const palette = getCellPalette(carryValue, colorMaxValue, roles);
                    carryItem.style.backgroundColor = palette.background;
                    carryItem.style.color = palette.text;
                    carryItem.textContent = carryValue;
                    if (roles.length > 0) {
                        carryItem.classList.add('tracked-cell');
                    }
                }

                row.appendChild(carryItem);
            }

            if (hasVariableLane) {
                const divider = document.createElement('div');
                divider.className = 'lane-divider';
                row.appendChild(divider);

                const variableValues = [step.minValue, step.maxValue];
                variableValues.forEach((variableValue, index) => {
                    const variableItem = document.createElement('div');
                    variableItem.className = 'item variable-item';

                    if (variableValue === null || variableValue === undefined) {
                        variableItem.classList.add('empty-item');
                        variableItem.textContent = '';
                    } else {
                        const roles = rolesByLane.vars.get(index) || [];
                        const palette = getCellPalette(variableValue, colorMaxValue, roles);
                        variableItem.style.backgroundColor = palette.background;
                        variableItem.style.color = palette.text;
                        variableItem.textContent = variableValue;
                        if (roles.length > 0) {
                            variableItem.classList.add('tracked-cell');
                        }
                    }

                    row.appendChild(variableItem);
                });
            }

            this.gridContainer.appendChild(row);
        });
    }

    renderRunError(error, algorithmName, inputList) {
        console.groupCollapsed('[SortLab] Algorithm run failed');
        console.log('simulatorIndex:', this.index);
        console.log('algorithm:', algorithmName);
        console.log('input:', inputList);
        if (error && error.details) {
            console.log('details:', error.details);
        }
        console.error(error);
        console.groupEnd();

        this.gridContainer.innerHTML = '';
        this.legendBar.innerHTML = '';
        const errorPanel = document.createElement('div');
        errorPanel.className = 'run-error';
        errorPanel.textContent = `Run failed: ${error && error.message ? error.message : 'Unknown error'}. Check the console.`;
        this.gridContainer.appendChild(errorPanel);

        this.lastRun = null;
        this.renderStats({ comparisons: 0, indexChecks: 0, swaps: 0 });
        this.codeOutput.textContent = Algorithms[algorithmName].code;
    }

    renderLegend(steps) {
        this.legendBar.innerHTML = '';

        const usedRoles = new Set();
        steps.forEach((step) => {
            (step.trackedIndices || []).forEach((entry) => {
                if (entry && entry.role) {
                    usedRoles.add(entry.role);
                }
            });
        });

        const orderedRoles = ROLE_DISPLAY_ORDER.filter((role) => usedRoles.has(role));
        if (orderedRoles.length === 0) {
            return;
        }

        orderedRoles.forEach((role) => {
            const chip = document.createElement('span');
            chip.className = 'legend-chip';

            const swatch = document.createElement('span');
            swatch.className = 'legend-swatch';
            const palette = getLegendPalette(role);
            swatch.style.backgroundColor = palette.background;
            swatch.style.color = palette.text;
            swatch.textContent = '■';

            const label = document.createElement('span');
            label.className = 'legend-label';
            label.textContent = ROLE_LABELS[role] || role;

            chip.appendChild(swatch);
            chip.appendChild(label);
            this.legendBar.appendChild(chip);
        });
    }

    getComparisonDisplaySteps(steps) {
        if (!Array.isArray(steps) || steps.length === 0) {
            return [];
        }

        const displaySteps = [];
        let previousComparisons = null;

        steps.forEach((step, index) => {
            const comparisons = step && step.statsSnapshot
                ? (step.statsSnapshot.comparisons ?? 0)
                : 0;

            if (index === 0) {
                displaySteps.push(step);
                previousComparisons = comparisons;
                return;
            }

            if (comparisons > previousComparisons) {
                displaySteps.push(step);
            }

            previousComparisons = comparisons;
        });

        return displaySteps;
    }

    renderFromList(list, colorMaxValue) {
        const algorithmName = this.algorithmSelect.value;
        let runResult;

        try {
            runResult = Algorithms[algorithmName].sort([...list], {
                maxRuntimeMs: SORT_RUN_TIMEOUT_MS,
                maxTicks: SORT_RUN_MAX_TICKS
            });
        } catch (error) {
            this.renderRunError(error, algorithmName, [...list]);
            return;
        }

        const steps = Array.isArray(runResult) ? runResult : runResult.steps;
        const stats = Array.isArray(runResult)
            ? { comparisons: 0, indexChecks: 0, swaps: 0 }
            : runResult.stats;
        this.lastRun = {
            algorithmName,
            inputList: [...list],
            steps,
            stats
        };
        const displaySteps = this.getComparisonDisplaySteps(steps);
        this.renderLegend(displaySteps);
        this.renderGrid(displaySteps, colorMaxValue);
        this.renderStats(stats);
        this.codeOutput.textContent = Algorithms[algorithmName].code;
    }

    renderStats(stats) {
        this.statsComparisons.textContent = stats.comparisons.toLocaleString();
        this.statsIndexChecks.textContent = (stats.indexChecks ?? 0).toLocaleString();
        this.statsSwaps.textContent = stats.swaps.toLocaleString();
    }
}

class SortLabApp {
    constructor() {
        this.simulators = [];
        this.counter = 0;
        this.listMode = 'sequence';
        this.compactVisualsEnabled = true;
        this.orderedList = [];
        this.shuffledList = [];
        this.draggedIndex = null;

        this.simulatorsContainer = document.getElementById('simulators');
        this.addSimulatorBtn = document.getElementById('add-simulator-btn');
        this.compactViewToggle = document.getElementById('compact-view-toggle');
        this.globalListLengthInput = document.getElementById('global-list-length');
        this.sequenceBtn = document.getElementById('sequence-btn');
        this.randomDistributionBtn = document.getElementById('random-distribution-btn');
        this.shuffleBtn = document.getElementById('shuffle-btn');
        this.orderedListLabel = document.getElementById('ordered-list-label');
        this.orderedListContainer = document.getElementById('ordered-list');
        this.shuffledListContainer = document.getElementById('shuffled-list');

        this.setupEventListeners();
        this.regenerateLists(this.listMode);
        this.addSimulator('quick');
        this.addSimulator('prediction');
    }

    setupEventListeners() {
        this.addSimulatorBtn.addEventListener('click', () => this.addSimulator());
        this.compactViewToggle.addEventListener('click', () => this.toggleCompactVisuals());
        this.globalListLengthInput.addEventListener('input', () => this.handleLengthChange());
        this.sequenceBtn.addEventListener('click', () => this.regenerateLists('sequence'));
        this.randomDistributionBtn.addEventListener('click', () => this.regenerateLists('linear-random'));
        this.shuffleBtn.addEventListener('click', () => this.shuffleCurrentList());
        window.addEventListener('resize', () => this.applyVisualizationScaling());

        this.updateCompactViewUi();
    }

    addSimulator(initialAlgorithm = 'bubble') {
        this.counter += 1;
        const simulator = new SortSimulator(
            this.counter,
            (instance) => this.removeSimulator(instance),
            () => this.renderAllSimulators()
        );

        simulator.algorithmSelect.value = initialAlgorithm;

        this.simulators.push(simulator);
        this.simulatorsContainer.insertBefore(simulator.root, this.addSimulatorBtn);
        this.updateRemoveButtonVisibility();
        this.updateSimulatorGridLayout();
        this.renderSimulator(simulator);
        this.applyVisualizationScaling();
    }

    removeSimulator(instance) {
        if (this.simulators.length === 1) {
            return;
        }

        this.simulators = this.simulators.filter((simulator) => simulator !== instance);
        instance.root.remove();
        this.updateRemoveButtonVisibility();
        this.updateSimulatorGridLayout();
        this.applyVisualizationScaling();
    }

    updateRemoveButtonVisibility() {
        const canRemove = this.simulators.length > 1;
        this.simulators.forEach((simulator) => {
            simulator.removeBtn.disabled = !canRemove;
            simulator.removeBtn.style.opacity = canRemove ? '1' : '0.5';
        });
    }

    updateSimulatorGridLayout() {
        const isSingleSimulator = this.simulators.length <= 1;
        this.simulatorsContainer.classList.toggle('single-simulator', isSingleSimulator);
        this.simulatorsContainer.style.setProperty(
            '--simulator-columns',
            String(Math.max(1, this.simulators.length))
        );
    }

    handleLengthChange() {
        const length = this.getListLength();
        if (length === null) {
            return;
        }

        this.regenerateLists(this.listMode);
    }

    getListLength() {
        const listLength = parseInt(this.globalListLengthInput.value, 10);
        if (Number.isNaN(listLength) || listLength < 5 || listLength > 100) {
            return null;
        }
        return listLength;
    }

    regenerateLists(mode) {
        const length = this.getListLength();
        if (length === null) {
            return;
        }

        this.listMode = mode;
        if (mode === 'linear-random') {
            const randomValues = [];
            for (let i = 0; i < length; i++) {
                randomValues.push(1 + Math.floor(Math.random() * length));
            }
            this.orderedList = [...randomValues].sort((a, b) => a - b);
            this.orderedListLabel.textContent = 'Sorted random sample';
        } else {
            this.orderedList = Array.from({ length }, (_, index) => index + 1);
            this.orderedListLabel.textContent = 'Complete sequence';
        }

        this.shuffleCurrentList();
    }

    shuffleCurrentList() {
        this.shuffledList = [...this.orderedList];
        for (let i = this.shuffledList.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.shuffledList[i], this.shuffledList[j]] = [this.shuffledList[j], this.shuffledList[i]];
        }

        this.renderListPanels();
        this.renderAllSimulators();
    }

    toggleCompactVisuals() {
        this.compactVisualsEnabled = !this.compactVisualsEnabled;
        this.updateCompactViewUi();
        this.applyVisualizationScaling();
    }

    updateCompactViewUi() {
        document.body.classList.toggle('compact-visuals-enabled', this.compactVisualsEnabled);
        this.compactViewToggle.classList.toggle('is-active', this.compactVisualsEnabled);
        this.compactViewToggle.setAttribute('aria-pressed', String(this.compactVisualsEnabled));
        this.compactViewToggle.textContent = this.compactVisualsEnabled
            ? 'Fit Height + Hide Numbers: On'
            : 'Fit Height + Hide Numbers: Off';
    }

    renderListPanels() {
        const colorMaxValue = Math.max(...this.orderedList, ...this.shuffledList);
        this.renderListPreview(this.orderedListContainer, this.orderedList, colorMaxValue, false);
        this.renderListPreview(this.shuffledListContainer, this.shuffledList, colorMaxValue, true);
    }

    renderListPreview(container, list, colorMaxValue, interactive) {
        container.innerHTML = '';

        list.forEach((value, index) => {
            const chip = document.createElement('div');
            chip.className = 'list-chip';
            chip.textContent = value;
            const palette = getCellPalette(value, colorMaxValue);
            chip.style.backgroundColor = palette.background;
            chip.style.color = palette.text;

            if (interactive) {
                chip.draggable = true;
                chip.dataset.index = index;
                chip.addEventListener('dragstart', (event) => this.handleDragStart(event));
                chip.addEventListener('dragenter', (event) => this.handleDragEnter(event));
                chip.addEventListener('dragover', (event) => this.handleDragOver(event));
                chip.addEventListener('dragleave', (event) => this.handleDragLeave(event));
                chip.addEventListener('drop', (event) => this.handleDrop(event));
                chip.addEventListener('dragend', (event) => this.handleDragEnd(event));
            }

            container.appendChild(chip);
        });
    }

    handleDragStart(event) {
        const chip = event.currentTarget;
        this.draggedIndex = Number(chip.dataset.index);
        chip.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
    }

    handleDragEnter(event) {
        event.preventDefault();
        event.currentTarget.classList.add('drop-target');
    }

    handleDragOver(event) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    }

    handleDragLeave(event) {
        event.currentTarget.classList.remove('drop-target');
    }

    handleDrop(event) {
        event.preventDefault();
        const targetChip = event.currentTarget;
        const targetIndex = Number(targetChip.dataset.index);
        targetChip.classList.remove('drop-target');

        if (this.draggedIndex === null || targetIndex === this.draggedIndex) {
            return;
        }

        const nextList = [...this.shuffledList];
        const [movedValue] = nextList.splice(this.draggedIndex, 1);
        nextList.splice(targetIndex, 0, movedValue);
        this.shuffledList = nextList;
        this.draggedIndex = null;
        this.renderListPanels();
        this.renderAllSimulators();
    }

    handleDragEnd(event) {
        event.currentTarget.classList.remove('dragging');
        this.clearDropTargets();
        this.draggedIndex = null;
    }

    clearDropTargets() {
        this.shuffledListContainer.querySelectorAll('.drop-target').forEach((chip) => {
            chip.classList.remove('drop-target');
        });
    }

    renderSimulator(simulator) {
        if (this.shuffledList.length === 0) {
            return;
        }

        const colorMaxValue = Math.max(...this.orderedList, ...this.shuffledList);
        simulator.renderFromList(this.shuffledList, colorMaxValue);
    }

    renderAllSimulators() {
        this.simulators.forEach((simulator) => {
            this.renderSimulator(simulator);
        });

        this.applyVisualizationScaling();
    }

    applyVisualizationScaling() {
        if (this.simulators.length === 0) {
            return;
        }

        if (!this.compactVisualsEnabled) {
            this.simulators.forEach((simulator) => {
                simulator.gridContainer.style.transform = '';
                simulator.visualizationArea.style.height = '';
            });
            return;
        }

        const tallestGridHeight = this.simulators.reduce((maxHeight, simulator) => {
            return Math.max(maxHeight, simulator.gridContainer.scrollHeight);
        }, 0);

        if (tallestGridHeight === 0) {
            return;
        }

        const top = this.simulatorsContainer.getBoundingClientRect().top;
        const availableHeight = Math.max(180, window.innerHeight - top - 24);
        const scale = Math.min(1, availableHeight / tallestGridHeight);

        this.simulators.forEach((simulator) => {
            const rawHeight = simulator.gridContainer.scrollHeight;
            simulator.gridContainer.style.transform = `scaleY(${scale})`;
            simulator.visualizationArea.style.height = `${Math.max(1, rawHeight * scale)}px`;
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new SortLabApp();
});
