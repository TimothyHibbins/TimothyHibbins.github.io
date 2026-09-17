function createStepCollector(liveValues, statsRef = null) {
    const steps = [{
        values: [...liveValues],
        trackedIndices: [],
        auxValues: null,
        carryValue: undefined,
        minValue: undefined,
        maxValue: undefined,
        writtenValues: null,
        displayValues: null,
        statsSnapshot: statsRef ? { ...statsRef } : undefined
    }];

    return {
        record(trackedIndices = [], auxValues = null, carryValue = undefined, minValue = undefined, maxValue = undefined, writtenValues = null, displayValues = null, packedSegmentData = null) {
            steps.push({
                values: [...liveValues],
                trackedIndices: trackedIndices.map((entry) => ({ ...entry })),
                auxValues: auxValues ? [...auxValues] : null,
                carryValue,
                minValue,
                maxValue,
                writtenValues: writtenValues ? [...writtenValues] : null,
                displayValues: displayValues ? [...displayValues] : null,
                packedSegmentData: packedSegmentData ? { ...packedSegmentData } : null,
                statsSnapshot: statsRef ? { ...statsRef } : undefined
            });
        },
        finalize() {
            const lastStep = steps[steps.length - 1];
            const sameValues = lastStep.values.length === liveValues.length
                && lastStep.values.every((value, index) => value === liveValues[index]);

            if (
                !sameValues
                || lastStep.trackedIndices.length > 0
                || lastStep.auxValues
                || lastStep.carryValue !== undefined
                || lastStep.minValue !== undefined
                || lastStep.maxValue !== undefined
                || lastStep.writtenValues
                || lastStep.displayValues
                || lastStep.statsSnapshot !== undefined
            ) {
                steps.push({
                    values: [...liveValues],
                    trackedIndices: [],
                    auxValues: null,
                    carryValue: undefined,
                    minValue: undefined,
                    maxValue: undefined,
                    writtenValues: null,
                    displayValues: null,
                    statsSnapshot: statsRef ? { ...statsRef } : undefined
                });
            }

            return steps;
        }
    };
}

function createStats() {
    return {
        comparisons: 0,
        indexChecks: 0,
        swaps: 0,
        reads: 0,
        writes: 0
    };
}

function createExecutionGuard(options = {}) {
    const maxRuntimeMs = Number.isFinite(options.maxRuntimeMs) && options.maxRuntimeMs > 0
        ? options.maxRuntimeMs
        : 1500;
    const maxTicks = Number.isFinite(options.maxTicks) && options.maxTicks > 0
        ? options.maxTicks
        : 250000;
    const startedAt = Date.now();
    let ticks = 0;

    return {
        tick(stage, context = {}) {
            ticks += 1;
            const elapsedMs = Date.now() - startedAt;

            if (ticks > maxTicks || elapsedMs > maxRuntimeMs) {
                const reason = ticks > maxTicks ? 'tick-limit' : 'time-limit';
                const error = new Error(`Sort execution timeout (${reason}) at ${stage}`);
                error.name = 'SortTimeoutError';
                error.details = {
                    reason,
                    stage,
                    elapsedMs,
                    ticks,
                    maxRuntimeMs,
                    maxTicks,
                    ...context
                };
                throw error;
            }
        }
    };
}

// Wraps an array in a Proxy that automatically increments stats.writes on every
// indexed assignment, so algorithm code never needs explicit stats.writes += N lines.
function createTrackedArray(arr, stats) {
    return new Proxy(arr, {
        set(target, prop, value) {
            const result = Reflect.set(target, prop, value);
            if (typeof prop === 'string' && Number.isInteger(+prop) && +prop >= 0) {
                stats.writes += 1;
            }
            return result;
        }
    });
}

const Algorithms = {
    bubble: {
        name: 'Bubble Sort',
        code: `function bubbleSort(arr) {
    const n = arr.length;
    for (let i = 0; i < n - 1; i++) {
        for (let j = 0; j < n - i - 1; j++) {
            if (arr[j] > arr[j + 1]) {
                [arr[j], arr[j + 1]] = [arr[j + 1], arr[j]];
            }
        }
    }
    return arr;
}`,
        sort(arr) {
            const stats = createStats();
            const values = createTrackedArray([...arr], stats);
            const collector = createStepCollector(values, stats);

            for (let i = 0; i < values.length - 1; i++) {
                for (let j = 0; j < values.length - i - 1; j++) {
                    stats.comparisons += 1;
                    stats.reads += 2;
                    if (values[j] > values[j + 1]) {
                        stats.reads += 2;
                        stats.swaps += 1;
                        [values[j], values[j + 1]] = [values[j + 1], values[j]];
                    }
                    collector.record([
                        { index: j, role: 'left' },
                        { index: j + 1, role: 'right' }
                    ]);
                }
            }

            return { steps: collector.finalize(), stats };
        }
    },

    selection: {
        name: 'Selection Sort',
        code: `function selectionSort(arr) {
    const n = arr.length;
    for (let i = 0; i < n - 1; i++) {
        let minIdx = i;
        for (let j = i + 1; j < n; j++) {
            if (arr[j] < arr[minIdx]) {
                minIdx = j;
            }
        }
        [arr[i], arr[minIdx]] = [arr[minIdx], arr[i]];
    }
    return arr;
}`,
        sort(arr) {
            const stats = createStats();
            const values = createTrackedArray([...arr], stats);
            const collector = createStepCollector(values, stats);

            for (let i = 0; i < values.length - 1; i++) {
                let minIndex = i;
                for (let j = i + 1; j < values.length; j++) {
                    stats.comparisons += 1;
                    stats.reads += 2;
                    if (values[j] < values[minIndex]) {
                        minIndex = j;
                    }
                    collector.record([
                        { index: i, role: 'anchor' },
                        { index: minIndex, role: 'min' },
                        { index: j, role: 'scan' }
                    ]);
                }

                if (minIndex !== i) {
                    stats.reads += 2;
                    stats.swaps += 1;
                    [values[i], values[minIndex]] = [values[minIndex], values[i]];
                }
            }

            return { steps: collector.finalize(), stats };
        }
    },

    insertion: {
        name: 'Insertion Sort',
        code: `function insertionSort(arr) {
    for (let i = 1; i < arr.length; i++) {
        const key = arr[i];
        let j = i - 1;
        while (j >= 0 && arr[j] > key) {
            arr[j + 1] = arr[j];
            j--;
        }
        arr[j + 1] = key;
    }
    return arr;
}`,
        sort(arr) {
            const stats = createStats();
            const values = createTrackedArray([...arr], stats);
            const collector = createStepCollector(values, stats);

            for (let i = 1; i < values.length; i++) {
                const key = values[i];
                stats.reads += 1;
                let j = i - 1;

                while (j >= 0) {
                    stats.comparisons += 1;
                    stats.reads += 1;
                    collector.record([
                        { index: j, role: 'left' },
                        { index: j + 1, role: 'right' }
                    ]);

                    if (!(values[j] > key)) {
                        break;
                    }

                    stats.reads += 1;
                    values[j + 1] = values[j];
                    j -= 1;
                }

                values[j + 1] = key;
            }

            return { steps: collector.finalize(), stats };
        }
    },

    merge: {
        name: 'Merge Sort',
        code: `function mergeSort(arr) {
    if (arr.length <= 1) return arr;
    const mid = Math.floor(arr.length / 2);
    const left = mergeSort(arr.slice(0, mid));
    const right = mergeSort(arr.slice(mid));
    return merge(left, right);
}

function merge(left, right) {
    const result = [];
    let l = 0;
    let r = 0;
    while (l < left.length && r < right.length) {
        if (left[l] <= right[r]) {
            result.push(left[l++]);
        } else {
            result.push(right[r++]);
        }
    }
    return result.concat(left.slice(l)).concat(right.slice(r));
}`,
        sort(arr) {
            const stats = createStats();
            const values = createTrackedArray([...arr], stats);
            const collector = createStepCollector(values, stats);

            const mergeSortRange = (left, right) => {
                if (left >= right) {
                    return;
                }

                const middle = Math.floor((left + right) / 2);
                mergeSortRange(left, middle);
                mergeSortRange(middle + 1, right);
                mergeRange(left, middle, right);
            };

            const mergeRange = (left, middle, right) => {
                const leftBuffer = values.slice(left, middle + 1);
                const rightBuffer = values.slice(middle + 1, right + 1);
                const auxValues = new Array(values.length).fill(null);

                for (let i = left; i <= middle; i++) {
                    auxValues[i] = leftBuffer[i - left];
                }
                for (let i = middle + 1; i <= right; i++) {
                    auxValues[i] = rightBuffer[i - (middle + 1)];
                }

                let li = 0;
                let ri = 0;
                let writeIndex = left;

                while (li < leftBuffer.length && ri < rightBuffer.length) {
                    const leftIndex = left + li;
                    const rightIndex = middle + 1 + ri;

                    stats.comparisons += 1;
                    stats.reads += 2;

                    if (leftBuffer[li] <= rightBuffer[ri]) {
                        stats.reads += 1;
                        values[writeIndex] = leftBuffer[li];
                        li += 1;
                    } else {
                        stats.reads += 1;
                        values[writeIndex] = rightBuffer[ri];
                        ri += 1;
                    }

                    collector.record([
                        { lane: 'aux', index: leftIndex, role: 'left' },
                        { lane: 'aux', index: rightIndex, role: 'right' },
                        { lane: 'main', index: writeIndex, role: 'write' }
                    ], auxValues);

                    writeIndex += 1;
                }

                while (li < leftBuffer.length) {
                    stats.reads += 1;
                    values[writeIndex] = leftBuffer[li];
                    li += 1;
                    writeIndex += 1;
                }

                while (ri < rightBuffer.length) {
                    stats.reads += 1;
                    values[writeIndex] = rightBuffer[ri];
                    ri += 1;
                    writeIndex += 1;
                }
            };

            mergeSortRange(0, values.length - 1);
            return { steps: collector.finalize(), stats };
        }
    },

    quick: {
        name: 'Quick Sort',
        code: `function quickSort(arr, low = 0, high = arr.length - 1) {
    if (low < high) {
        const split = partition(arr, low, high);
        quickSort(arr, low, split);
        quickSort(arr, split + 1, high);
    }
    return arr;
}

function partition(arr, low, high) {
    const pivot = arr[Math.floor((low + high) / 2)];
    let left = low;
    let right = high;

    while (true) {
        while (arr[left] < pivot) {
            left += 1;
        }
        while (arr[right] > pivot) {
            right -= 1;
        }
        if (left >= right) {
            return right;
        }
        [arr[left], arr[right]] = [arr[right], arr[left]];
        left += 1;
        right -= 1;
    }
}`,
        sort(arr) {
            const stats = createStats();
            const values = createTrackedArray([...arr], stats);
            const collector = createStepCollector(values, stats);

            const partition = (low, high) => {
                const pivotIndex = Math.floor((low + high) / 2);
                const pivot = values[pivotIndex];
                stats.reads += 1;
                let left = low;
                let right = high;

                while (true) {
                    while (true) {
                        stats.comparisons += 1;
                        stats.reads += 1;
                        collector.record([
                            { index: left, role: 'left' },
                            { index: right, role: 'right' },
                            { index: pivotIndex, role: 'pivot' }
                        ]);
                        if (!(values[left] < pivot)) {
                            break;
                        }
                        left += 1;
                    }

                    while (true) {
                        stats.comparisons += 1;
                        stats.reads += 1;
                        collector.record([
                            { index: left, role: 'left' },
                            { index: right, role: 'right' },
                            { index: pivotIndex, role: 'pivot' }
                        ]);
                        if (!(values[right] > pivot)) {
                            break;
                        }
                        right -= 1;
                    }

                    if (left >= right) {
                        return right;
                    }

                    stats.reads += 2;
                    stats.swaps += 1;
                    [values[left], values[right]] = [values[right], values[left]];
                    left += 1;
                    right -= 1;
                }
            };

            const quickSortRange = (low, high) => {
                if (low >= high) {
                    return;
                }
                const split = partition(low, high);
                quickSortRange(low, split);
                quickSortRange(split + 1, high);
            };

            quickSortRange(0, values.length - 1);
            return { steps: collector.finalize(), stats };
        }
    },

    prediction: {
        name: 'Prediction Sort',
        code: `function predictionSort(arr) {
    if (arr.length <= 1) return arr;

    const endIndex = arr.length - 1;

    if (arr[endIndex] < arr[0]) {
        [arr[0], arr[endIndex]] = [arr[endIndex], arr[0]];
    }

    let i = 1;
    while (i < endIndex) {
        if (arr[i] < arr[0]) {
            [arr[0], arr[i]] = [arr[i], arr[0]];
        }
        if (arr[i] > arr[endIndex]) {
            [arr[endIndex], arr[i]] = [arr[i], arr[endIndex]];
            continue;
        }
        i += 1;
    }

    const min = arr[0];
    const max = arr[endIndex];
    const interiorStart = 1;
    const interiorEnd = endIndex - 1;
    const step = arr.length > 1 ? (max - min) / endIndex : 0;

    const marked = new Array(arr.length).fill(false);
    marked[0] = true;
    marked[endIndex] = true;
    let markedCount = arr.length > 1 ? 2 : 1;

    const predictIndex = (value) => {
        if (step === 0) return interiorStart;
        const predicted = Math.round((value - min) / step);
        return Math.max(interiorStart, Math.min(interiorEnd, predicted));
    };

    const swap = (left, right) => {
        [arr[left], arr[right]] = [arr[right], arr[left]];
    };

    const setMarked = (index) => {
        if (!marked[index]) {
            marked[index] = true;
            markedCount += 1;
        }
    };

    const nextUnmarked = (fromIndex) => {
        const clampedStart = Math.max(interiorStart, Math.min(interiorEnd + 1, fromIndex));

        for (let index = clampedStart; index <= interiorEnd; index += 1) {
            if (!marked[index]) {
                return index;
            }
        }

        for (let index = interiorStart; index < clampedStart; index += 1) {
            if (!marked[index]) {
                return index;
            }
        }

        return interiorEnd + 1;
    };

    const advanceFirstUnmarked = (currentIndex) => {
        if (markedCount >= arr.length) {
            return interiorEnd + 1;
        }
        return nextUnmarked(currentIndex + 1);
    };

    let firstUnmarked = interiorStart;
    const originAttempts = new Array(arr.length).fill(0);

    while (markedCount < arr.length) {
        originAttempts[firstUnmarked] += 1;
        if (originAttempts[firstUnmarked] > arr.length * 2) {
            setMarked(firstUnmarked);
            firstUnmarked = nextUnmarked(firstUnmarked + 1);
            continue;
        }

        let check = predictIndex(arr[firstUnmarked]);

        if (arr[check] === arr[firstUnmarked]) {
            setMarked(check);
            if (check === firstUnmarked) {
                firstUnmarked = advanceFirstUnmarked(firstUnmarked);
                continue;
            }
        }

        if (!marked[check]) {
            swap(firstUnmarked, check);
            setMarked(check);
            continue;
        }

        const insertionDirection = firstUnmarked < check ? -1 : 1;
        const originValue = arr[firstUnmarked];

        if (insertionDirection < 0) {
            while (check > interiorStart && marked[check]) {
                if (arr[check] < originValue) { break; }
                check -= 1;
            }
            // Scan right to find rightmost position where value < origin
            if (marked[check] && arr[check] < originValue) {
                while (check < interiorEnd && marked[check + 1] && arr[check + 1] < originValue) {
                    check += 1;
                }
            }
        } else {
            while (check < interiorEnd && marked[check]) {
                if (arr[check] > originValue) { break; }
                check += 1;
            }
            // Scan left to find leftmost position where value > origin
            if (marked[check] && arr[check] > originValue) {
                while (check > interiorStart && marked[check - 1] && arr[check - 1] > originValue) {
                    check -= 1;
                }
            }
        }

        const insertionSlotWasMarked = marked[check];
        const shiftDirection = firstUnmarked < check ? -1 : 1;

        swap(firstUnmarked, check);

        if (!insertionSlotWasMarked) {
            setMarked(check);
            if (firstUnmarked === check) {
                firstUnmarked = advanceFirstUnmarked(firstUnmarked);
            }
            continue;
        }

        check += shiftDirection;
        while (check >= interiorStart && check <= interiorEnd && marked[check]) {
            if (
                (shiftDirection < 0 && arr[check] < arr[firstUnmarked])
                || (shiftDirection > 0 && arr[check] > arr[firstUnmarked])
            ) {
                swap(firstUnmarked, check);
            }
            check += shiftDirection;
        }

        if (check < interiorStart) {
            check = interiorStart;
        } else if (check > interiorEnd) {
            check = interiorEnd;
        }

        swap(firstUnmarked, check);
        setMarked(check);

        if (firstUnmarked === check) {
            firstUnmarked = advanceFirstUnmarked(firstUnmarked);
        }
    }

    for (let i = 1; i < arr.length; i += 1) {
        const key = arr[i];
        let j = i - 1;
        while (j >= 0 && arr[j] > key) {
            arr[j + 1] = arr[j];
            j -= 1;
        }
        arr[j + 1] = key;
    }

    return arr;
}`,
        sort(arr, options = {}) {
            const stats = createStats();
            const values = createTrackedArray([...arr], stats);
            const collector = createStepCollector(values, stats);
            const guard = createExecutionGuard(options);

            if (values.length <= 1) {
                return { steps: collector.finalize(), stats };
            }

            stats.comparisons += 1;
            stats.reads += 2;
            const endpointSwap = values[values.length - 1] < values[0];
            const endpointRoles = [
                { lane: 'main', index: 0, role: 'min' },
                { lane: 'main', index: values.length - 1, role: 'max' }
            ];

            if (endpointSwap) {
                stats.reads += 2;
                stats.swaps += 1;
                endpointRoles.push(
                    { lane: 'main', index: 0, role: 'write' },
                    { lane: 'main', index: values.length - 1, role: 'write' }
                );
            }

            collector.record(endpointRoles);
            if (endpointSwap) {
                [values[0], values[values.length - 1]] = [values[values.length - 1], values[0]];
            }

            let i = 1;
            while (i < values.length - 1) {
                guard.tick('endpoint-normalization', { i, length: values.length });

                const minCompareRoles = [
                    { lane: 'main', index: 0, role: 'min' },
                    { lane: 'main', index: values.length - 1, role: 'max' },
                    { lane: 'main', index: i, role: 'scan' }
                ];

                stats.comparisons += 1;
                stats.reads += 2;
                const shouldSwapMin = values[i] < values[0];
                collector.record(minCompareRoles);

                if (shouldSwapMin) {
                    stats.reads += 2;
                    stats.swaps += 1;
                    [values[0], values[i]] = [values[i], values[0]];
                }

                const maxCompareRoles = [
                    { lane: 'main', index: 0, role: 'min' },
                    { lane: 'main', index: values.length - 1, role: 'max' },
                    { lane: 'main', index: i, role: 'scan' }
                ];

                stats.comparisons += 1;
                stats.reads += 2;
                const shouldSwapMax = values[i] > values[values.length - 1];
                collector.record(maxCompareRoles);

                if (shouldSwapMax) {
                    stats.reads += 2;
                    stats.swaps += 1;
                    [values[values.length - 1], values[i]] = [values[i], values[values.length - 1]];
                    continue;
                }

                i += 1;
            }

            const min = values[0];
            const max = values[values.length - 1];
            const interiorStart = 1;
            const interiorEnd = values.length - 2;
            const step = values.length > 1 ? (max - min) / (values.length - 1) : 0;
            const marked = new Array(values.length).fill(false);
            marked[0] = true;
            marked[values.length - 1] = true;
            let markedCount = values.length > 1 ? 2 : 1;

            const predictIndex = (value) => {
                if (step === 0) {
                    return interiorStart;
                }
                const predicted = Math.round((value - min) / step);
                return Math.max(interiorStart, Math.min(interiorEnd, predicted));
            };

            const swapValues = (left, right) => {
                stats.reads += 2;
                stats.swaps += 1;
                [values[left], values[right]] = [values[right], values[left]];
            };

            const recordMarkedScan = (index, role = 'scan') => {
                stats.indexChecks += 1;
                collector.record([
                    { lane: 'main', index, role }
                ], null, undefined, undefined, undefined, marked);
            };

            const setMarked = (index) => {
                if (!marked[index]) {
                    marked[index] = true;
                    markedCount += 1;
                }
            };

            const firstUnmarkedIndex = (startFrom = interiorStart) => {
                const clampedStart = Math.max(interiorStart, Math.min(interiorEnd + 1, startFrom));

                for (let index = clampedStart; index <= interiorEnd; index++) {
                    guard.tick('first-unmarked-scan-forward', { index, interiorStart, interiorEnd });
                    recordMarkedScan(index);
                    if (!marked[index]) {
                        return index;
                    }
                }

                for (let index = interiorStart; index < clampedStart; index++) {
                    guard.tick('first-unmarked-scan-wrap', { index, interiorStart, interiorEnd });
                    recordMarkedScan(index);
                    if (!marked[index]) {
                        return index;
                    }
                }

                return interiorEnd + 1;
            };

            const advanceFirstUnmarked = (currentIndex) => {
                if (markedCount >= values.length) {
                    return interiorEnd + 1;
                }
                return firstUnmarkedIndex(currentIndex + 1);
            };

            const originAttempts = new Array(values.length).fill(0);
            let firstUnmarked = firstUnmarkedIndex(interiorStart);
            while (markedCount < values.length) {
                guard.tick('prediction-origin', { firstUnmarked });
                originAttempts[firstUnmarked] += 1;
                if (originAttempts[firstUnmarked] > values.length * 2) {
                    setMarked(firstUnmarked);
                    collector.record([
                        { lane: 'main', index: firstUnmarked, role: 'origin' }
                    ], null, undefined, undefined, undefined, marked);
                    firstUnmarked = firstUnmarkedIndex(firstUnmarked + 1);
                    continue;
                }

                let check = predictIndex(values[firstUnmarked]);

                stats.comparisons += 1;
                collector.record([
                    { lane: 'main', index: firstUnmarked, role: 'origin' },
                    { lane: 'main', index: check, role: 'predicted' }
                ], null, undefined, undefined, undefined, marked);

                if (values[check] === values[firstUnmarked]) {
                    setMarked(check);
                    collector.record([
                        { lane: 'main', index: firstUnmarked, role: 'origin' },
                        { lane: 'main', index: check, role: 'predicted' }
                    ], null, undefined, undefined, undefined, marked);

                    if (check === firstUnmarked) {
                        firstUnmarked = advanceFirstUnmarked(firstUnmarked);
                        continue;
                    }
                }

                stats.indexChecks += 1;
                collector.record([
                    { lane: 'main', index: firstUnmarked, role: 'origin' },
                    { lane: 'main', index: check, role: 'predicted' }
                ], null, undefined, undefined, undefined, marked);
                if (!marked[check]) {
                    swapValues(firstUnmarked, check);
                    setMarked(check);
                    collector.record([
                        { lane: 'main', index: firstUnmarked, role: 'origin' },
                        { lane: 'main', index: check, role: 'predicted' }
                    ], null, undefined, undefined, undefined, marked);
                    continue;
                }

                const insertionDirection = firstUnmarked < check ? -1 : 1;
                const originValue = values[firstUnmarked];

                if (insertionDirection < 0) {
                    while (check > interiorStart && marked[check]) {
                        guard.tick('prediction-insert-left', { firstUnmarked, check });
                        stats.comparisons += 1;
                        collector.record([
                            { lane: 'main', index: firstUnmarked, role: 'origin' },
                            { lane: 'main', index: check, role: 'scan' }
                        ], null, undefined, undefined, undefined, marked);
                        if (values[check] < originValue) {
                            break;
                        }
                        check -= 1;
                    }
                    // Scan right to find rightmost position where value < origin
                    if (marked[check] && values[check] < originValue) {
                        while (check < interiorEnd && marked[check + 1] && values[check + 1] < originValue) {
                            guard.tick('prediction-insert-right-boundary', { firstUnmarked, check });
                            stats.comparisons += 1;
                            collector.record([
                                { lane: 'main', index: firstUnmarked, role: 'origin' },
                                { lane: 'main', index: check, role: 'scan' }
                            ], null, undefined, undefined, undefined, marked);
                            check += 1;
                        }
                    }
                } else {
                    while (check < interiorEnd && marked[check]) {
                        guard.tick('prediction-insert-right', { firstUnmarked, check });
                        stats.comparisons += 1;
                        collector.record([
                            { lane: 'main', index: firstUnmarked, role: 'origin' },
                            { lane: 'main', index: check, role: 'scan' }
                        ], null, undefined, undefined, undefined, marked);
                        if (values[check] > originValue) {
                            break;
                        }
                        check += 1;
                    }
                    // Scan left to find leftmost position where value > origin
                    if (marked[check] && values[check] > originValue) {
                        while (check > interiorStart && marked[check - 1] && values[check - 1] > originValue) {
                            guard.tick('prediction-insert-left-boundary', { firstUnmarked, check });
                            stats.comparisons += 1;
                            collector.record([
                                { lane: 'main', index: firstUnmarked, role: 'origin' },
                                { lane: 'main', index: check, role: 'scan' }
                            ], null, undefined, undefined, undefined, marked);
                            check -= 1;
                        }
                    }
                }

                const insertionSlotWasMarked = marked[check];
                const shiftDirection = firstUnmarked < check ? -1 : 1;

                swapValues(firstUnmarked, check);
                collector.record([
                    { lane: 'main', index: firstUnmarked, role: 'origin' },
                    { lane: 'main', index: check, role: 'predicted' }
                ], null, undefined, undefined, undefined, marked);

                if (!insertionSlotWasMarked) {
                    setMarked(check);
                    collector.record([
                        { lane: 'main', index: firstUnmarked, role: 'origin' },
                        { lane: 'main', index: check, role: 'next' }
                    ], null, undefined, undefined, undefined, marked);

                    if (firstUnmarked === check) {
                        firstUnmarked = advanceFirstUnmarked(firstUnmarked);
                    }
                    continue;
                }

                check += shiftDirection;
                while (check >= interiorStart && check <= interiorEnd && marked[check]) {
                    guard.tick('prediction-chain-shift', { firstUnmarked, check });
                    stats.indexChecks += 1;
                    collector.record([
                        { lane: 'main', index: firstUnmarked, role: 'origin' },
                        { lane: 'main', index: check, role: 'next' }
                    ], null, undefined, undefined, undefined, marked);

                    stats.comparisons += 1;
                    collector.record([
                        { lane: 'main', index: firstUnmarked, role: 'origin' },
                        { lane: 'main', index: check, role: 'next' }
                    ], null, undefined, undefined, undefined, marked);
                    if (
                        (shiftDirection < 0 && values[check] < values[firstUnmarked])
                        || (shiftDirection > 0 && values[check] > values[firstUnmarked])
                    ) {
                        swapValues(firstUnmarked, check);
                        collector.record([
                            { lane: 'main', index: firstUnmarked, role: 'origin' },
                            { lane: 'main', index: check, role: 'next' }
                        ], null, undefined, undefined, undefined, marked);
                    }

                    check += shiftDirection;
                }

                if (check < interiorStart) {
                    check = interiorStart;
                } else if (check > interiorEnd) {
                    check = interiorEnd;
                }

                swapValues(firstUnmarked, check);
                setMarked(check);
                collector.record([
                    { lane: 'main', index: firstUnmarked, role: 'origin' },
                    { lane: 'main', index: check, role: 'next' }
                ], null, undefined, undefined, undefined, marked);

                if (firstUnmarked === check) {
                    firstUnmarked = advanceFirstUnmarked(firstUnmarked);
                }
            }

            // Background correctness check — not part of the visualisation.
            for (let i = 1; i < values.length; i += 1) {
                if (values[i - 1] > values[i]) {
                    console.error(
                        'predictionSort: array not sorted after main loop',
                        { input: inputSnapshot, output: values.slice() }
                    );
                    break;
                }
            }

            return { steps: collector.finalize(), stats };
        }
    },

    predictiveCounting: {
        name: 'Predictive Counting Sort',
        code: `// Predictive Counting Sort — displacement-chain / in-place count table
//
// Cell types (integer array, 32-bit words):
//   Raw cell   bit31=0          plain absolute value
//   Slot cell  bits31-30 = 10   packs up to k (±Δ, count) pairs into bits 0-30
//   CT cell    bits31-30 = 11   bits 20-29=count, bits 0-19=relVal  (Phase 2 output)
//
// Phase 1 — Displacement chain
//   For each raw cell: convert it to an empty slot cell, then insert its
//   value into the nearest slot cell where |delta| <= deltaMax.
//   If the target is still a raw cell, displace it (push onto stack) and
//   convert that cell instead.  Overflow goes to a small Map.
//
// Phase 2 — Compact counts left (no auxiliary array)
//   Walk relVals 0..range in order.  For each relVal with total count > 0:
//     - scan slot cells in the window where this relVal fits; clear the match
//     - evict any remaining slots from arr[w] into overflow
//     - write CT cell (relVal, totalCount) to arr[w++]
//   After the loop, arr[0..k-1] is the count table; k = number of distinct values.
//
// Phase 3 — Expand right-to-left (safe: ∑counts[0..j] ≥ j+1 for all j)
//   ww = n-1
//   for ct = k-1 downto 0:
//     absVal = relVal(arr[ct]) + min
//     repeat count(arr[ct]) times: arr[ww--] = absVal

function predictiveCounting(arr) {
    const n = arr.length;
    if (n <= 1) return arr;

    let min = arr[0], max = arr[0];
    for (let i = 1; i < n; i++) {
        if (arr[i] < min) min = arr[i];
        if (arr[i] > max) max = arr[i];
    }
    const range = max - min;

    // Bit budget: pack (deltaEnc, count) pairs into 31 usable bits
    const deltaMax = Math.max(1, Math.ceil(range / n));
    const deltaBits = Math.ceil(Math.log2(2 * deltaMax + 2));
    const countBits = Math.ceil(Math.log2(n + 1));
    const pairBits  = deltaBits + countBits;
    const slotsPerCell = Math.floor(31 / pairBits);

    const SLOT_FLAG = 0x80000000;
    const CT_FLAG   = 0xC0000000;
    const isSlot = c => (c >>> 30) === 2;
    const isCT   = c => (c >>> 30) === 3;
    const anchorRel = idx => Math.round((idx / (n - 1)) * range);
    const overflowCounts = new Map();

    // ── Phase 1: Displacement chain ──────────────────────────────────────────
    for (let i = 0; i < n; i++) {
        if (isSlot(arr[i])) continue;
        const pending = [{ relVal: arr[i] - min, srcIdx: i }];
        arr[i] = SLOT_FLAG;
        while (pending.length > 0) {
            const { relVal } = pending.pop();
            const ideal = Math.round((relVal / range) * (n - 1));
            let placed = false;
            for (let d = 0; d < n && !placed; d++) {
                for (const k of (d === 0 ? [ideal] : [ideal - d, ideal + d])) {
                    if (k < 0 || k >= n) continue;
                    const delta = relVal - anchorRel(k);
                    if (Math.abs(delta) > deltaMax) continue;
                    if (isSlot(arr[k])) {
                        // try to insert into an empty slot
                        // (or increment existing matching slot)
                        placed = /* insertIntoSlot(arr, k, delta) */ true;
                        break;
                    } else {
                        pending.push({ relVal: arr[k] - min, srcIdx: k });
                        arr[k] = /* newSlotCell(delta) */ SLOT_FLAG;
                        placed = true; break;
                    }
                }
            }
            if (!placed) overflowCounts.set(relVal, (overflowCounts.get(relVal) || 0) + 1);
        }
    }

    // ── Phase 2: Compact counts to the left ──────────────────────────────────
    let w = 0;
    for (let relVal = 0; relVal <= range; relVal++) {
        let count = overflowCounts.get(relVal) || 0;
        overflowCounts.delete(relVal);
        for (let idx = 0; idx < n; idx++) {          // gather from slot cells
            if (!isSlot(arr[idx])) continue;
            const delta = relVal - anchorRel(idx);
            if (Math.abs(delta) > deltaMax) continue;
            // find matching slot, add its count, zero the slot
            count += /* extractSlotCount(arr, idx, delta) */ 0;
        }
        if (count === 0) continue;
        if (isSlot(arr[w])) /* evictSlots(arr, w, overflowCounts) */ 0;
        arr[w++] = CT_FLAG | ((count & 0x3FF) << 20) | (relVal & 0xFFFFF);
    }
    const k = w;  // number of distinct values; arr[0..k-1] = count table

    // ── Phase 3: Expand right-to-left ────────────────────────────────────────
    let ww = n - 1;
    for (let ct = k - 1; ct >= 0; ct--) {
        const absVal = (arr[ct] & 0xFFFFF) + min;
        const count  = (arr[ct] >>> 20) & 0x3FF;
        for (let c = 0; c < count; c++) arr[ww--] = absVal;
    }
    return arr;
}`,
        sort(inputValues, options) {
            const n = inputValues.length;
            if (n <= 1) {
                const stats = createStats();
                const collector = createStepCollector(inputValues, stats);
                return { steps: collector.finalize(), stats };
            }

            const guard = createExecutionGuard(options);
            const stats = createStats();
            const values = createTrackedArray(inputValues.slice(), stats);
            const collector = createStepCollector(values, stats);

            // ── Phase 1: find min / max ─────────────────────────────────────
            let min = values[0];
            let max = values[0];

            for (let i = 1; i < n; i++) {
                guard.tick();
                stats.reads += 1;
                stats.indexChecks += 1;
                if (values[i] < min) { min = values[i]; stats.comparisons += 1; }
                if (values[i] > max) { max = values[i]; stats.comparisons += 1; }
                collector.record([
                    { lane: 'main', index: i, role: 'scan' }
                ], null, undefined, min, max);
            }

            const range = max - min;
            const valueBits = range === 0 ? 1 : Math.ceil(Math.log2(range + 1));
            const countBits = Math.ceil(Math.log2(n + 1));
            // halfCount: only one value can exceed n/2, so bins only need to store up to n/2.
            const halfN = Math.floor(n / 2);
            const halfCountBits = halfN <= 1 ? 1 : Math.ceil(Math.log2(halfN + 1));

            // All packed modes require room for at least valueBits in each cell's low bits.
            if (valueBits >= 31) {
                console.warn('predictiveCounting: valueBits too large for packed modes; using fallback sort');
                values.sort((a, b) => a - b);
                return { steps: collector.finalize(), stats };
            }

            const valueMask = (1 << valueBits) - 1;

            const countShift = 2 * valueBits;

            const getOrigRelVal = (cell) => cell & valueMask;
            const getBinRelVal = (cell) => (cell >> valueBits) & valueMask;
            const getBinCount = (cell) => (cell >> countShift) & halfCountMask;
            const hasBin = (cell) => getBinCount(cell) > 0;
            // Claim an unclaimed cell as the bin for relVal (preserves origRelVal in low bits).
            const claimBin = (cell, relVal) => (cell & valueMask) | (relVal << valueBits) | (1 << countShift);
            // Low-level increment (does NOT cap at halfN — use incrementBinSafe in Phase 2).
            const incrementBin = (cell) => cell + (1 << countShift);

            // Overflow tracking for the halfCount optimisation.
            // At most one value can have count > halfN (strict majority property).
            let overflowRelVal = -1;
            let overflowExtra = 0;
            const incrementBinSafe = (cell, relVal) => {
                if (getBinCount(cell) >= halfN) {
                    overflowRelVal = relVal;
                    overflowExtra += 1;
                    return cell; // bin count stays capped at halfN
                }
                return cell + (1 << countShift);
            };

            // NOTE: values[] is kept as absolute throughout the displacement-chain path.
            // Non-displacement-chain fallbacks subtract min before they run (see below).

            // Display helpers ─────────────────────────────────────────────────
            // Format: "origAbsVal|syntheticInfo"
            //   primary  (left of |): original value at this index — never changes
            //   secondary (right of |): bin claim in high bits, "binAbsVal ×count", or "" if unclaimed
            const buildPackedDisplayValues = () => values.map((cell) => {
                const origAbsVal = getOrigRelVal(cell) + min;
                const count = getBinCount(cell);
                if (count === 0) {
                    return `${origAbsVal}|`;
                }
                const binRelVal = getBinRelVal(cell);
                const binAbsVal = binRelVal + min;
                const trueCount = count + (binRelVal === overflowRelVal ? overflowExtra : 0);
                return `${origAbsVal}|${binAbsVal} ×${trueCount}`;
            });

            // During expansion (3a): low bits hold either origRelVal or sorted relVal;
            // high bits (bin metadata) are always intact regardless of write pointer position.
            const buildExpansionDisplayValues = () => values.map((cell) => {
                const primaryAbsVal = (cell & valueMask) + min;
                const count = getBinCount(cell);
                if (count === 0) return `${primaryAbsVal}|`;
                const binRelVal = getBinRelVal(cell);
                const binAbsVal = binRelVal + min;
                const trueCount = count + (binRelVal === overflowRelVal ? overflowExtra : 0);
                return `${primaryAbsVal}|${binAbsVal} ×${trueCount}`;
            });

            // During strip (3b): cells before stripPos are plain integers; the rest still packed.
            const buildStripDisplayValues = (stripPos) => values.map((cell, idx) => {
                if (idx < stripPos) return `${cell}|`;
                const sortedAbsVal = (cell & valueMask) + min;
                const count = getBinCount(cell);
                if (count === 0) return `${sortedAbsVal}|`;
                const binAbsVal = getBinRelVal(cell) + min;
                return `${sortedAbsVal}|${binAbsVal} ×${count}`;
            });

            const recordPacked = (trackedIndices = []) => {
                collector.record(trackedIndices, null, undefined, min, max, null, buildPackedDisplayValues());
            };


            // ── Mode B: delta microbuckets (multi pair per index) ──────────
            // Store (delta-from-anchor, count) pairs in each index's high bits.
            // If a relVal cannot fit any microbucket slot, it spills into an
            // overflow map and is merged back during expansion.
            const stepEstimate = range / Math.max(1, n - 1);
            const deltaMax = Math.max(1, Math.ceil(stepEstimate));
            const deltaCardinality = 2 * deltaMax + 1;
            const deltaBits = Math.ceil(Math.log2(deltaCardinality));
            const pairBits = deltaBits + 2;
            const microSlotsPerCell = pairBits > 0 ? Math.floor(31 / pairBits) : 0;

            // Displacement-chain model uses SENTINEL (bit 31) to mark converted cells.
            // Raw absolute values must have bit 31 = 0, which is guaranteed when
            // min >= 0 and max < 2^31. Negative inputs fall through to overlay3.
            const canUseDisplacementChain = microSlotsPerCell >= 1
                && min >= 0
                && (max >>> 0) < 0x80000000;


            // ── Displacement-chain encoding: cell-format constants and accessors ─────────
            // Displacement-chain model: each cell is either a raw ABSOLUTE value
            // (bit 31 clear) or a converted slot cell (bit 31 set as SENTINEL).
            // No original value is preserved in low bits — cells are fully overwritten.
            const SENTINEL = 0x80000000 >>> 0;
            const isSlotCell = (cell) => ((cell >>> 0) >>> 30) === 2; // bits 31-30 = 10
            const makeEmptySlotCell = () => SENTINEL;
            // Count-table cells: bits 31-30 = 11, bits 20-29 = count (10 bits), bits 0-19 = relVal (20 bits)
            const isCountTableCell = (cell) => ((cell >>> 0) >>> 30) === 3;
            const makeCtCell = (relVal, count) =>
                (0xC0000000 | ((count & 0x3FF) << 20) | (relVal & 0xFFFFF)) >>> 0;
            const ct2RelVal = (cell) => (cell >>> 0) & 0xFFFFF;
            const ct2Count = (cell) => ((cell >>> 0) >>> 20) & 0x3FF;

            const pairMask = (1 << pairBits) - 1;
            const deltaBias = deltaMax;
            const longPayloadBits = deltaBits;       // 2-bit mode payload width
            const shortPayloadBits = deltaBits - 1;   // 3-bit mode payload width
            const longPayloadMask = (1 << longPayloadBits) - 1;
            const shortPayloadMask = (1 << shortPayloadBits) - 1;

            // Prefix-free mode codes (top bits of sub-slot word).
            // Top bit 0 → 2-bit mode (bits[pairBits-1:pairBits-2]), payload = deltaBits bits.
            // Top bit 1 → 3-bit mode (bits[pairBits-1:pairBits-3]), payload = deltaBits-1 bits.
            // word = 0 is EMPTY (IDEAL payload 0 never occurs: payload = deltaEnc+1 >= 1).
            const MODE_IDEAL = 0b00;  // 2-bit; payload = deltaEnc+1
            const MODE_PREV_CHAIN = 0b01;  // 2-bit; payload = unsigned chain delta (new − prev)
            const MODE_COUNT = 0b100; // 3-bit; payload = count-2 (follows IDEAL or DISP+IDEAL)
            const MODE_NEXT_CHAIN = 0b101; // 3-bit; payload = chain delta (reserved, not yet placed)
            const MODE_DISP_RIGHT = 0b110; // 3-bit; payload = d; next sub-slot = IDEAL at anchorRel(idx-d)
            const MODE_DISP_LEFT = 0b111; // 3-bit; payload = d; next sub-slot = IDEAL at anchorRel(idx+d)

            const anchorRel = (idx) => {
                if (range === 0 || n <= 1) return 0;
                return Math.round((idx / (n - 1)) * range);
            };

            // Slots packed from bit 0 upwards; no original-value reserved low bits.
            const getSlotShift = (slot) => slot * pairBits;
            const getSlotWord = (cell, slot) => ((cell >>> 0) >>> getSlotShift(slot)) & pairMask;
            const setSlotWord = (cell, slot, word) => {
                const shift = getSlotShift(slot);
                const c = cell >>> 0;
                const clearMask = (~(pairMask << shift)) >>> 0;
                return ((c & clearMask) | ((word & pairMask) << shift)) >>> 0;
            };
            const slotIsEmpty = (word) => (word & pairMask) === 0;
            const slotHasLongMode = (word) => ((word >>> (pairBits - 1)) & 1) === 0;
            const getMode = (word) => {
                const w = word & pairMask;
                return slotHasLongMode(w)
                    ? (w >>> longPayloadBits) & 0b11
                    : (w >>> shortPayloadBits) & 0b111;
            };
            const getPayload = (word) => {
                const w = word & pairMask;
                return slotHasLongMode(w) ? (w & longPayloadMask) : (w & shortPayloadMask);
            };
            const makeWord = (mode, payload) =>
                mode <= 0b01
                    ? ((mode << longPayloadBits) | (payload & longPayloadMask)) >>> 0
                    : ((mode << shortPayloadBits) | (payload & shortPayloadMask)) >>> 0;
            const makeIdealWord = (deltaEnc) => makeWord(MODE_IDEAL, deltaEnc + 1);
            const makePrevChain = (chainDelta) => makeWord(MODE_PREV_CHAIN, chainDelta);
            const makeCountWord = (count) => makeWord(MODE_COUNT, count - 2);
            const makeDispR = (d) => makeWord(MODE_DISP_RIGHT, d);
            const makeDispL = (d) => makeWord(MODE_DISP_LEFT, d);
            const unpackIdealDeltaEnc = (word) => getPayload(word) - 1;
            // Preferred slot index for IDEAL, distributing by value quantile.
            const preferredSlot = (dEnc) =>
                Math.min(microSlotsPerCell - 1,
                    Math.floor(dEnc / (2 * deltaBias + 1) * microSlotsPerCell));


            // ── Display helpers (visualization — format live values[] as display strings) ─
            // Raw cells show absolute value; slot cells show their slot contents;
            // count-table cells show primary=absVal and secondary=absVal×count.
            // overrideIdx/overrideCell: show the original slot cell at idx even if it
            // has already been zeroed in values[] (used during collect-step recording).
            const buildDisplayValues = (overrideIdx = -1, overrideCell = 0, dstOverrideIdx = -1, dstOverrideCell = 0) => values.map((cell, i) => {
                const c = (i === overrideIdx ? overrideCell : i === dstOverrideIdx ? dstOverrideCell : cell) >>> 0;
                if (isCountTableCell(c)) {
                    const absVal = ct2RelVal(c) + min;
                    const count = ct2Count(c);
                    return `${absVal}|${absVal}\u00d7${count}`;
                }
                if (!isSlotCell(c)) {
                    if (c === 0) return `|`; // empty consumed cell
                    return `${c}|`;  // raw absolute value
                }
                const parts = [];
                iterSlotPairs(c, i, (rel, cnt, _slot, isDisplaced) => {
                    parts.push(isDisplaced ? `${rel + min}\u21a7` : cnt > 1 ? `${rel + min} \u00d7${cnt}` : `${rel + min}`);
                });
                return `|${parts.join(', ')}`;
            });

            // During right-to-left expansion: count-table entries and empty cells on
            // the left, plain written values on the right.
            // ctOverrideIdx/ctOverrideCell: pass the current CT cell being expanded so
            // its position shows as a CT entry even after values[ct] has been overwritten
            // by the first write (which happens when ww == ct, i.e. cnt == 1).
            const buildPhase3DisplayValues = (ctOverrideIdx = -1, ctOverrideCell = 0) => values.map((cell, idx) => {
                const c = (idx === ctOverrideIdx ? ctOverrideCell : cell) >>> 0;
                if (isCountTableCell(c)) {
                    const absVal = ct2RelVal(c) + min;
                    const count = ct2Count(c);
                    return `${absVal}|${absVal}\u00d7${count}`;
                }
                if (isSlotCell(c)) return `|`; // shouldn't occur in Phase 3
                if (c === 0) return `|`; // empty (consumed slot or not-yet-written)
                return `${cell}`; // plain sorted value (no pipe)
            });


            // Decode all valid (relVal, cnt, slotStart) pairs in a slot cell, calling
            // onPair(relVal, cnt, slotStart) for each. Handles IDEAL (+optional COUNT),
            // PREV_CHAIN, and DISP_R/L+IDEAL pairs; skips empty/invalid/out-of-range entries.
            const iterSlotPairs = (cell, idx, onPair) => {
                const aRel = anchorRel(idx);
                let prevRel = null;
                let s = 0;
                const collected = [];
                while (s < microSlotsPerCell) {
                    const word = getSlotWord(cell, s);
                    if (slotIsEmpty(word)) { s += 1; continue; }
                    const mode = getMode(word);
                    if (mode === MODE_COUNT) { s += 1; continue; }
                    const slotStart = s;
                    if (mode === MODE_IDEAL) {
                        const dEnc = unpackIdealDeltaEnc(word);
                        let cnt = 1;
                        if (s + 1 < microSlotsPerCell) {
                            const nx = getSlotWord(cell, s + 1);
                            if (!slotIsEmpty(nx) && getMode(nx) === MODE_COUNT) { cnt = getPayload(nx) + 2; s += 2; }
                            else { s += 1; }
                        } else { s += 1; }
                        if (cnt <= 0) continue;
                        const relVal = aRel + (dEnc - deltaBias);
                        if (relVal < 0 || relVal > range) continue;
                        if (prevRel === null || relVal > prevRel) prevRel = relVal;
                        collected.push({ relVal, cnt, slotStart, isDisplaced: false });
                    } else if (mode === MODE_PREV_CHAIN) {
                        const relVal = (prevRel ?? aRel) + getPayload(word);
                        prevRel = relVal;
                        s += 1;
                        if (relVal < 0 || relVal > range) continue;
                        collected.push({ relVal, cnt: 1, slotStart, isDisplaced: false });
                    } else if (mode === MODE_DISP_RIGHT || mode === MODE_DISP_LEFT) {
                        const d = getPayload(word);
                        const dispIdx = mode === MODE_DISP_RIGHT ? idx - d : idx + d;
                        const dispAnchor = anchorRel(Math.max(0, Math.min(n - 1, dispIdx)));
                        s += 2;
                        if (slotStart + 1 >= microSlotsPerCell) continue;
                        const iw = getSlotWord(cell, slotStart + 1);
                        if (slotIsEmpty(iw) || getMode(iw) !== MODE_IDEAL) continue;
                        const relVal = dispAnchor + (unpackIdealDeltaEnc(iw) - deltaBias);
                        if (relVal < 0 || relVal > range) continue;
                        prevRel = relVal;
                        collected.push({ relVal, cnt: 1, slotStart, isDisplaced: true });
                    } else { s += 1; }
                }
                collected.sort((a, b) => a.relVal - b.relVal);
                for (const { relVal, cnt, slotStart, isDisplaced } of collected) {
                    onPair(relVal, cnt, slotStart, isDisplaced);
                }
            };
            if (canUseDisplacementChain) {
                // Phase 1: Displacement-chain pass.
                // For each raw cell i: convert it to an empty slot cell, then place its
                // original relVal at its ideal index, displacing any occupant into the chain.
                for (let i = 0; i < n; i += 1) {
                    guard.tick();
                    if (isSlotCell(values[i])) continue;
                    collector.record([{ lane: 'main', index: i, role: 'scan', part: 'orig' }], null, undefined, min, max, null, buildDisplayValues());
                    const firstRelVal = values[i] - min; // absolute → relative
                    values[i] = makeEmptySlotCell();

                    const pending = [{ relVal: firstRelVal, srcIdx: i }];
                    while (pending.length > 0) {
                        guard.tick();
                        const { relVal, srcIdx } = pending.pop();
                        const ideal = range === 0 ? 0
                            : Math.max(0, Math.min(n - 1, Math.round((relVal / range) * (n - 1))));
                        let placed = false;
                        // Build display values with the scan source showing the value being placed
                        // (not the current slot/empty state), so the renderer sees the correct
                        // colour and label instead of the slot cell that overwrote the original.
                        const absValToPlace = relVal + min;
                        const buildDv = () => {
                            const dv = buildDisplayValues();
                            dv[srcIdx] = `${absValToPlace}|`;
                            return dv;
                        };

                        for (let d = 0; d < n && !placed; d += 1) {
                            const cands = d === 0 ? [ideal] : [ideal - d, ideal + d];
                            for (const k of cands) {
                                if (k < 0 || k >= n) continue;
                                const cell = values[k] >>> 0;
                                const aRel = anchorRel(k);
                                const delta = relVal - aRel;
                                if (Math.abs(delta) > deltaMax) continue;
                                const deltaEnc = delta + deltaBias;

                                if (isSlotCell(cell)) {
                                    // Already converted: scan for matching IDEAL (count increment)
                                    // or an empty slot for a new IDEAL sub-slot.
                                    const pSlot = preferredSlot(deltaEnc);
                                    let preferredEmpty = -1;
                                    let anyEmpty = -1;
                                    let inserted = false;
                                    let maxRelInCell = null; // max relVal seen (for PREV_CHAIN)
                                    let s = 0;
                                    while (s < microSlotsPerCell && !inserted) {
                                        const word = getSlotWord(cell, s);
                                        if (slotIsEmpty(word)) {
                                            if (s === pSlot && preferredEmpty === -1) preferredEmpty = s;
                                            else if (anyEmpty === -1 || Math.abs(s - pSlot) < Math.abs(anyEmpty - pSlot)) anyEmpty = s;
                                            s += 1;
                                        } else {
                                            const mode = getMode(word);
                                            if (mode === MODE_IDEAL) {
                                                const wDEnc = unpackIdealDeltaEnc(word);
                                                const wRel = aRel + (wDEnc - deltaBias);
                                                if (wRel > (maxRelInCell ?? -Infinity)) maxRelInCell = wRel;
                                                if (wDEnc === deltaEnc) {
                                                    // Matching IDEAL found — try to increment count.
                                                    let countStored = false;
                                                    const nextS = s + 1;
                                                    if (nextS < microSlotsPerCell) {
                                                        const nw = getSlotWord(cell, nextS);
                                                        if (slotIsEmpty(nw)) {
                                                            // No count slot yet → write COUNT(2) into next slot.
                                                            values[k] = setSlotWord(cell, nextS, makeCountWord(2));
                                                            collector.record([
                                                                { lane: 'main', index: srcIdx, role: 'scan', part: 'orig' },
                                                                { lane: 'main', index: k, role: 'write', part: 'bin', slot: s }
                                                            ], null, undefined, min, max, null, buildDv());
                                                            countStored = true;
                                                        } else if (getMode(nw) === MODE_COUNT) {
                                                            const cnt = getPayload(nw); // payload = actual_count - 2
                                                            if (cnt < shortPayloadMask) {
                                                                values[k] = setSlotWord(cell, nextS, makeCountWord(cnt + 3));
                                                                collector.record([
                                                                    { lane: 'main', index: srcIdx, role: 'scan', part: 'orig' },
                                                                    { lane: 'main', index: k, role: 'write', part: 'bin', slot: s }
                                                                ], null, undefined, min, max, null, buildDv());
                                                                countStored = true;
                                                            }
                                                            // COUNT at max — fall through to place as new IDEAL in another cell
                                                        }
                                                    }
                                                    if (countStored) inserted = true;
                                                }
                                                s += 1;
                                                // Skip the following COUNT sub-slot if present.
                                                if (s < microSlotsPerCell) {
                                                    const nw = getSlotWord(cell, s);
                                                    if (!slotIsEmpty(nw) && getMode(nw) === MODE_COUNT) s += 1;
                                                }
                                            } else if (mode === MODE_COUNT) {
                                                s += 1; // orphan COUNT — skip
                                            } else if (mode === MODE_PREV_CHAIN) {
                                                const wRel = (maxRelInCell ?? aRel) + getPayload(word);
                                                if (wRel > (maxRelInCell ?? -Infinity)) maxRelInCell = wRel;
                                                s += 1;
                                            } else if (mode === MODE_DISP_RIGHT || mode === MODE_DISP_LEFT) {
                                                s += 2; // skip DISP + following IDEAL
                                            } else {
                                                s += 1;
                                            }
                                        }
                                    }
                                    // Fallback: insert as new IDEAL in an empty slot.
                                    if (!inserted) {
                                        const writeSlot = preferredEmpty !== -1 ? preferredEmpty : anyEmpty;
                                        if (writeSlot !== -1) {
                                            values[k] = setSlotWord(cell, writeSlot, makeIdealWord(deltaEnc));
                                            collector.record([
                                                { lane: 'main', index: srcIdx, role: 'scan', part: 'orig' },
                                                { lane: 'main', index: k, role: 'write', part: 'bin', slot: writeSlot }
                                            ], null, undefined, min, max, null, buildDv());
                                            inserted = true;
                                        }
                                    }
                                    // PREV_CHAIN: relVal > max in cell, append after last occupied slot.
                                    if (!inserted && maxRelInCell !== null && relVal > maxRelInCell) {
                                        const chainDelta = relVal - maxRelInCell;
                                        if (chainDelta <= longPayloadMask) {
                                            let lastFree = -1;
                                            for (let ss = microSlotsPerCell - 1; ss >= 0; ss--) {
                                                if (slotIsEmpty(getSlotWord(cell, ss))) { lastFree = ss; break; }
                                            }
                                            if (lastFree !== -1) {
                                                values[k] = setSlotWord(cell, lastFree, makePrevChain(chainDelta));
                                                collector.record([
                                                    { lane: 'main', index: srcIdx, role: 'scan', part: 'orig' },
                                                    { lane: 'main', index: k, role: 'write', part: 'bin', slot: lastFree }
                                                ], null, undefined, min, max, null, buildDv());
                                                inserted = true;
                                            }
                                        }
                                    }
                                    if (inserted) { placed = true; break; }
                                } else {
                                    // Raw cell: displace its occupant and fully overwrite with new slot.
                                    const displaced = cell - min; // absolute → relative
                                    const pSlot = preferredSlot(deltaEnc);
                                    values[k] = setSlotWord(makeEmptySlotCell(), pSlot, makeIdealWord(deltaEnc));
                                    collector.record([
                                        { lane: 'main', index: srcIdx, role: 'scan', part: 'orig' },
                                        { lane: 'main', index: k, role: 'write', part: 'bin', slot: pSlot }
                                    ], null, undefined, min, max, null, buildDv());
                                    pending.push({ relVal: displaced, srcIdx: k });
                                    placed = true;
                                    break;
                                }
                            }
                        }

                        // DISPLACED fallback: value couldn't be placed via IDEAL/PREV_CHAIN
                        // anywhere within its delta range. Scan all slot cells for 2
                        // consecutive free sub-slots and store a DISP_R/L + IDEAL pair.
                        if (!placed) {
                            const maxDispD = (1 << shortPayloadBits) - 1;
                            for (let k2 = 0; k2 < n && !placed; k2++) {
                                const dd = Math.abs(k2 - ideal);
                                if (dd === 0 || dd > maxDispD) continue;
                                const cell2 = values[k2] >>> 0;
                                if (!isSlotCell(cell2)) continue;
                                for (let s = 0; s + 1 < microSlotsPerCell && !placed; s++) {
                                    if (!slotIsEmpty(getSlotWord(cell2, s)) || !slotIsEmpty(getSlotWord(cell2, s + 1))) continue;
                                    const dispMode = k2 > ideal ? makeDispR(dd) : makeDispL(dd);
                                    const dispDelta = relVal - anchorRel(ideal);
                                    const dispDeltaEnc = dispDelta + deltaBias;
                                    let nc = setSlotWord(cell2, s, dispMode);
                                    nc = setSlotWord(nc, s + 1, makeIdealWord(dispDeltaEnc));
                                    values[k2] = nc;
                                    collector.record([
                                        { lane: 'main', index: srcIdx, role: 'scan', part: 'orig' },
                                        { lane: 'main', index: k2, role: 'write', part: 'bin', slot: s }
                                    ], null, undefined, min, max, null, buildDv());
                                    placed = true;
                                }
                            }
                        }
                        // If still not placed, the value is truly lost (pathological input).
                    }
                }

                // Phase 2: Two-pass read directly from the already-sorted slot cells.
                // Slot cells are in non-decreasing order of relVal: anchorRel increases
                // monotonically with idx, and within each cell micro-slots are distributed
                // by preferredSlot(dEnc) ∝ deltaEnc ∝ relVal, so iterating s = 0..
                // microSlotsPerCell-1 yields pairs in ascending relVal order.
                //
                // Pass 1 (scan, no writes): walk slot cells to find maxCtCount and
                //   the total distinct-pair count (countTableSize).
                // Pass 2 (compress, left-to-right writes): re-scan the same slot cells and
                //   either pack each (relVal, count) pair into a tight bit-stream using
                //   absolute relVals (if packedWords < countTableSize) or write plain CT
                //   entries directly (if packing saves nothing).
                const bitsFor = (x) => x === 0 ? 1 : 32 - Math.clz32(x);
                let countTableSize = 0;
                let maxCtCount = 0;
                {
                    for (let idx = 0; idx < n; idx += 1) {
                        guard.tick();
                        const cell = values[idx] >>> 0;
                        if (!isSlotCell(cell)) continue;
                        iterSlotPairs(cell, idx, (relVal, cnt) => {
                            if (cnt > maxCtCount) maxCtCount = cnt;
                            countTableSize += 1;
                        });
                    }
                }
                const relValBits = bitsFor(range);
                const ctCntBits = bitsFor(maxCtCount);
                const ctPairBits = relValBits + ctCntBits;
                const packedWords = Math.ceil(countTableSize * ctPairBits / 32);
                const relValMask = (1 << relValBits) - 1;
                const ctCntMask = (1 << ctCntBits) - 1;
                // Will be populated inside the packing branch (wWordSegs is in scope there).
                let phase3SegmentData = null;

                if (packedWords < countTableSize) {
                    // Pass 2 (packing): encode each (relVal, count) pair into
                    // relValBits+ctCntBits bits and write into values[0..packedWords-1].
                    let r = 0;
                    let lastInitWord = -1;
                    // Maps logical pair index r → CT-formatted display string.
                    const packedDisplayStrings = new Map();
                    // Per-word accumulated segment data: wWord → [{startBit, width, colorValue, filled}].
                    // Lives outside the idx loop so each step sees ALL pairs packed so far.
                    const wWordSegs = new Map();
                    for (let idx = 0; idx < n; idx += 1) {
                        guard.tick();
                        const cell = values[idx] >>> 0;
                        if (!isSlotCell(cell)) continue;
                        iterSlotPairs(cell, idx, (relVal, cnt, slotStart) => {
                            const absVal = relVal + min;
                            const pair = (relVal | (cnt << relValBits)) >>> 0;
                            const bitOff = r * ctPairBits;
                            const wWord = (bitOff / 32) | 0;
                            const wShift = bitOff & 31;
                            const bitsInFirst = Math.min(ctPairBits, 32 - wShift);
                            const loMask = (1 << bitsInFirst) - 1;

                            if (wWord !== lastInitWord) { values[wWord] = 0; lastInitWord = wWord; }
                            values[wWord] = ((values[wWord] >>> 0) | ((pair & loMask) << wShift)) >>> 0;

                            if (!wWordSegs.has(wWord)) wWordSegs.set(wWord, []);
                            wWordSegs.get(wWord).push({ startBit: wShift, width: bitsInFirst, colorValue: absVal, filled: true });

                            if (bitsInFirst < ctPairBits) {
                                const bitsInSecond = ctPairBits - bitsInFirst;
                                const wWord2 = wWord + 1;
                                if (wWord2 !== lastInitWord) { values[wWord2] = 0; lastInitWord = wWord2; }
                                values[wWord2] = ((values[wWord2] >>> 0) | (((pair >>> bitsInFirst) >>> 0) & ((1 << bitsInSecond) - 1))) >>> 0;
                                if (!wWordSegs.has(wWord2)) wWordSegs.set(wWord2, []);
                                wWordSegs.get(wWord2).push({ startBit: 0, width: bitsInSecond, colorValue: absVal, filled: true });
                            }
                            // Record this pair at its logical index r so each pair gets its own
                            // visual cell; show the slot cell at idx as the value being extracted.
                            packedDisplayStrings.set(r, `${absVal}|${absVal}\u00d7${cnt}`);
                            const dvCompress = buildDisplayValues(idx, makeCtCell(relVal, cnt));
                            for (const [pos, str] of packedDisplayStrings) {
                                dvCompress[pos] = str;
                            }
                            // Re-apply source: the loop above may have overwritten dvCompress[idx]
                            // when idx <= r (pointing to a different pair's string).
                            dvCompress[idx] = `${absVal}|${absVal}\u00d7${cnt}`;
                            // Show the label on the wider fragment; if equal, primary (wWord) wins.
                            const _bitsIn2c = ctPairBits - bitsInFirst;
                            dvCompress[wWord] = (bitsInFirst >= _bitsIn2c)
                                ? packedDisplayStrings.get(r) : `${absVal}|`;
                            const compressTracked = [
                                { lane: 'main', index: idx, role: 'scan', part: 'compress', bitOffset: slotStart * pairBits, bitWidth: pairBits },
                                { lane: 'main', index: wWord, role: 'write', part: 'compress', bitOffset: wShift, bitWidth: bitsInFirst }
                            ];
                            if (bitsInFirst < ctPairBits) {
                                dvCompress[wWord + 1] = (bitsInFirst >= _bitsIn2c)
                                    ? `${absVal}|` : packedDisplayStrings.get(r);
                                compressTracked.push({ lane: 'main', index: wWord + 1, role: 'write', part: 'compress', bitOffset: 0, bitWidth: ctPairBits - bitsInFirst });
                            }
                            // Build per-word segment snapshot for this step (all pairs packed so far).
                            const segsForRecord = {};
                            for (const [ww, segs] of wWordSegs) segsForRecord[ww] = segs.slice();
                            // Temporarily restore the original slot cell so the renderer can show
                            // per-slot stripes for the source position.
                            const origAtIdx = values[idx];
                            values[idx] = cell;
                            collector.record(compressTracked, null, undefined, min, max, null, dvCompress, segsForRecord);
                            values[idx] = origAtIdx;
                            r += 1;
                        });
                    }
                    // Snapshot the final segment layout for Phase 3 expansion colour display.
                    phase3SegmentData = {};
                    for (const [pw, segs] of wWordSegs) phase3SegmentData[pw] = segs.slice();
                    // Zero the freed tail (positions packedWords..countTableSize-1 are now spare)
                    for (let p = packedWords; p < countTableSize; p += 1) {
                        values[p] = 0;
                    }
                } else {
                    // Packing saves nothing: write CT entries directly at values[0..countTableSize-1].
                    let w = 0;
                    for (let idx = 0; idx < n; idx += 1) {
                        guard.tick();
                        const cell = values[idx] >>> 0;
                        if (!isSlotCell(cell)) continue;
                        iterSlotPairs(cell, idx, (relVal, cnt, slotStart) => {
                            const ctCell = makeCtCell(relVal, cnt);
                            values[w] = ctCell;
                            const dvCompress = buildDisplayValues(idx, ctCell);
                            const origAtIdx = values[idx];
                            values[idx] = cell;
                            collector.record([
                                { lane: 'main', index: idx, role: 'scan', part: 'compress', bitOffset: slotStart * pairBits, bitWidth: pairBits },
                                { lane: 'main', index: w, role: 'write', part: 'compress' }
                            ], null, undefined, min, max, null, dvCompress);
                            values[idx] = origAtIdx;
                            w += 1;
                        });
                    }
                }

                // Phase 3: Expand right-to-left. If Phase 2b packed into a bit-stream,
                // pairs are read directly in reverse order using absolute relVals (no
                // intermediate decode step). Safety: write pointer ww ≥ r+1 > r ≥ wWord,
                // so writes never reach packed words before they are fully read.
                // Otherwise expand from plain CT entries.
                if (packedWords < countTableSize) {
                    // Pre-compute a representative absVal for each packed word so that
                    // non-active words show individual meaningful colours during expansion.
                    // Uses the first pair that starts within each word.
                    const packedWordPrimaryAbsVal = new Array(packedWords).fill(min);
                    for (let pw = 0; pw < packedWords; pw += 1) {
                        const r0 = Math.ceil(pw * 32 / ctPairBits);
                        if (r0 < countTableSize) {
                            const bo0 = r0 * ctPairBits;
                            const sh0 = bo0 & 31;
                            const bf0 = Math.min(ctPairBits, 32 - sh0);
                            let p0 = ((values[pw] >>> sh0) >>> 0) & ((1 << bf0) - 1);
                            if (bf0 < ctPairBits) {
                                p0 |= ((values[pw + 1] >>> 0) & ((1 << (ctPairBits - bf0)) - 1)) << bf0;
                            }
                            packedWordPrimaryAbsVal[pw] = (p0 & relValMask) + min;
                        }
                    }
                    let ww = n - 1;
                    for (let r = countTableSize - 1; r >= 0; r -= 1) {
                        guard.tick();
                        const bitOff = r * ctPairBits;
                        const wWord = (bitOff / 32) | 0;
                        const wShift = bitOff & 31;
                        const bitsInFirst = Math.min(ctPairBits, 32 - wShift);
                        const loMask = (1 << bitsInFirst) - 1;
                        let pair = ((values[wWord] >>> wShift) >>> 0) & loMask;
                        if (bitsInFirst < ctPairBits) {
                            const bitsInSecond = ctPairBits - bitsInFirst;
                            pair |= ((values[wWord + 1] >>> 0) & ((1 << bitsInSecond) - 1)) << bitsInFirst;
                        }
                        const relVal = pair & relValMask;
                        const cnt = (pair >>> relValBits) & ctCntMask;
                        const absVal = relVal + min;
                        const expandScanTracked = [
                            { lane: 'main', index: wWord, role: 'scan', part: 'expand', bitOffset: wShift, bitWidth: bitsInFirst }
                        ];
                        if (bitsInFirst < ctPairBits) {
                            expandScanTracked.push({ lane: 'main', index: wWord + 1, role: 'scan', part: 'expand', bitOffset: 0, bitWidth: ctPairBits - bitsInFirst });
                        }
                        for (let c = 0; c < cnt; c += 1) {
                            guard.tick();
                            values[ww] = absVal;
                            const dvExpand = buildPhase3DisplayValues();
                            // Each packed word that hasn't been overwritten yet gets its own
                            // representative colour (first pair in that word). The active
                            // word(s) are then overridden with the full CT-format label.
                            for (let w = 0; w < packedWords; w += 1) {
                                if (w < ww) dvExpand[w] = `${packedWordPrimaryAbsVal[w]}|`;
                            }
                            // Show the label on the wider fragment; if equal, primary (wWord) wins.
                            const _bitsIn2e = ctPairBits - bitsInFirst;
                            dvExpand[wWord] = (bitsInFirst >= _bitsIn2e)
                                ? `${absVal}|${absVal}\u00d7${cnt}` : `${absVal}|`;
                            if (bitsInFirst < ctPairBits) {
                                dvExpand[wWord + 1] = (bitsInFirst >= _bitsIn2e)
                                    ? `${absVal}|` : `${absVal}|${absVal}\u00d7${cnt}`;
                            }
                            const stepSegs = {};
                            if (phase3SegmentData) {
                                for (const pw of Object.keys(phase3SegmentData)) {
                                    const pwi = +pw;
                                    if (pwi < ww) stepSegs[pwi] = phase3SegmentData[pwi];
                                }
                                // Always include the currently-scanned word(s): when wWord+1 === ww
                                // the loop above excludes it (pwi < ww is false), but dvExpand
                                // explicitly marks it as a colour-only cell — segment colours must show.
                                if (wWord in phase3SegmentData) stepSegs[wWord] = phase3SegmentData[wWord];
                                if (bitsInFirst < ctPairBits && (wWord + 1) in phase3SegmentData) {
                                    stepSegs[wWord + 1] = phase3SegmentData[wWord + 1];
                                }
                            }
                            collector.record(
                                [...expandScanTracked, { lane: 'main', index: ww, role: 'write', part: 'expand' }],
                                null, undefined, min, max, null, dvExpand, stepSegs);
                            ww -= 1;
                        }
                    }
                } else {
                    let ww = n - 1;
                    for (let ct = countTableSize - 1; ct >= 0; ct -= 1) {
                        guard.tick();
                        const ctCell = values[ct] >>> 0;
                        const relVal3 = ct2RelVal(ctCell);
                        const cnt3 = ct2Count(ctCell);
                        const absVal = relVal3 + min;
                        for (let c = 0; c < cnt3; c += 1) {
                            guard.tick();
                            values[ww] = absVal;
                            // Pass ctCell as override so position ct always shows as its CT entry
                            // even when ww == ct (count==1 case) and values[ct] was just overwritten.
                            collector.record([
                                { lane: 'main', index: ct, role: 'scan', part: 'expand' },
                                { lane: 'main', index: ww, role: 'write', part: 'expand' }
                            ], null, undefined, min, max, null, buildPhase3DisplayValues(ct, ctCell));
                            ww -= 1;
                        }
                    }
                }

                return {
                    steps: collector.finalize(),
                    stats,
                    predictiveBits: {
                        mode: 'deltaMicrobucket',
                        valueBits: 0,
                        pairBits,
                        countBits,
                        deltaBits,
                        deltaMax,
                        slotsPerCell: microSlotsPerCell,
                        flagMode: false
                    }
                };
            }

            // Displacement-chain was skipped (min < 0 or max too large, or pairBits too wide).
            // Remaining modes operate on relative values, so subtract min now.
            for (let i = 0; i < n; i++) values[i] -= min;

            const canUseOverlay3 = (2 * valueBits + halfCountBits <= 31);
            if (!canUseOverlay3) {
                // No packed collision-reducing mode is viable; keep correctness.
                values.sort((a, b) => a - b);
                for (let i = 0; i < n; i += 1) {
                    values[i] += min;
                }
                return { steps: collector.finalize(), stats };
            }

            // ── Phase 2: scan values, insert bins in sorted order in-place ──
            // Bins live in the mid+high bits at each position. We insert each
            // new relVal into the correct sorted position immediately, shifting
            // only mid+high bits rightward to make room. Low bits (origRelVal)
            // are NEVER modified here. This keeps bins always sorted, so Phase 3
            // can expand left-to-right without any separate sorting pass.
            const hasInteriorBins = n > 2;
            const interiorStart = hasInteriorBins ? 1 : 0;
            // Interior bins are compacted and sorted at interiorStart..interiorBinEnd-1.
            let interiorBinEnd = interiorStart;

            for (let i = 0; i < n; i++) {
                guard.tick();
                stats.reads += 1;
                stats.indexChecks += 1;

                const relVal = getOrigRelVal(values[i]);

                // ── endpoint: min ────────────────────────────────────────────
                if (relVal === 0) {
                    if (!hasBin(values[0])) values[0] = claimBin(values[0], 0);
                    else values[0] = incrementBinSafe(values[0], 0);
                    recordPacked([
                        { lane: 'main', index: i, role: 'origin', part: 'orig' },
                        { lane: 'main', index: 0, role: 'write', part: 'bin' }
                    ]);
                    continue;
                }

                // ── endpoint: max ────────────────────────────────────────────
                if (relVal === range) {
                    if (!hasBin(values[n - 1])) values[n - 1] = claimBin(values[n - 1], range);
                    else values[n - 1] = incrementBinSafe(values[n - 1], range);
                    recordPacked([
                        { lane: 'main', index: i, role: 'origin', part: 'orig' },
                        { lane: 'main', index: n - 1, role: 'write', part: 'bin' }
                    ]);
                    continue;
                }

                if (!hasInteriorBins) continue;

                // ── interior: binary search for sorted insertion point ───────
                // Bins in interiorStart..interiorBinEnd-1 are always sorted by relVal.
                let lo = interiorStart, hi = interiorBinEnd;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    stats.comparisons += 1;
                    stats.reads += 1;
                    if (getBinRelVal(values[mid]) < relVal) lo = mid + 1;
                    else hi = mid;
                }
                const ins = lo;

                if (ins < interiorBinEnd && getBinRelVal(values[ins]) === relVal) {
                    // Exact match: increment count in-place.
                    stats.comparisons += 1;
                    values[ins] = incrementBinSafe(values[ins], relVal);
                    recordPacked([
                        { lane: 'main', index: i, role: 'origin', part: 'orig' },
                        { lane: 'main', index: ins, role: 'write', part: 'bin' }
                    ]);
                } else {
                    // New relVal: shift bin metadata rightward to open slot at ins.
                    // Only mid+high bits move — low bits (origRelVal) are untouched.
                    for (let j = interiorBinEnd; j > ins; j -= 1) {
                        guard.tick();
                        values[j] = (values[j] & valueMask) | (values[j - 1] & ~valueMask);
                        recordPacked([
                            { lane: 'main', index: j - 1, role: 'scan', part: 'bin' },
                            { lane: 'main', index: j, role: 'write', part: 'bin' }
                        ]);
                    }
                    values[ins] = claimBin(values[ins], relVal);
                    interiorBinEnd += 1;
                    recordPacked([
                        { lane: 'main', index: i, role: 'origin', part: 'orig' },
                        { lane: 'main', index: ins, role: 'write', part: 'bin' }
                    ]);
                }
            }

            // ── Phase 3a: expand bins into low bits, left-to-right ──────────
            // We write only the low valueBits of each cell, leaving the high-bit
            // bin metadata intact. This means the write pointer can safely overtake
            // the read pointer (count > 1): getBinRelVal / getBinCount still read
            // correctly from mid/high bits even after the low bits have been updated.
            let w = 0;
            for (let r = 0; r < n; r++) {
                const count = getBinCount(values[r]);
                if (count === 0) continue;
                const relVal = getBinRelVal(values[r]); // read before low bits of values[r] change
                // Add any overflow count if this is the majority value.
                const extra = (relVal === overflowRelVal) ? overflowExtra : 0;
                const totalCount = count + extra;
                for (let c = 0; c < totalCount; c += 1) {
                    guard.tick();
                    values[w] = (values[w] & ~valueMask) | relVal;
                    collector.record([
                        { lane: 'main', index: w, role: 'write' }
                    ], null, undefined, min, max, null, buildExpansionDisplayValues());
                    w += 1;
                }
            }

            // ── Phase 3b: strip high bits, convert relVal → absVal ───────────
            for (let i = 0; i < n; i++) {
                guard.tick();
                values[i] = (values[i] & valueMask) + min;
                collector.record([
                    { lane: 'main', index: i, role: 'write' }
                ], null, undefined, min, max, null, buildStripDisplayValues(i + 1));
            }

            return {
                steps: collector.finalize(),
                stats,
                predictiveBits: { mode: 'overlay3', valueBits, countShift }
            };
        }
    }
};
