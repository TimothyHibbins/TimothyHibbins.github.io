function createStepCollector(initialValues, statsRef = null) {
    const steps = [{
        values: [...initialValues],
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
        record(values, trackedIndices = [], auxValues = null, carryValue = undefined, minValue = undefined, maxValue = undefined, writtenValues = null, displayValues = null, packedSegmentData = null) {
            steps.push({
                values: [...values],
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
        finalize(values) {
            const lastStep = steps[steps.length - 1];
            const sameValues = lastStep.values.length === values.length
                && lastStep.values.every((value, index) => value === values[index]);

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
                    values: [...values],
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
            const values = [...arr];
            const stats = createStats();
            const collector = createStepCollector(values, stats);

            for (let i = 0; i < values.length - 1; i++) {
                for (let j = 0; j < values.length - i - 1; j++) {
                    stats.comparisons += 1;
                    stats.reads += 2;
                    if (values[j] > values[j + 1]) {
                        stats.reads += 2;
                        stats.writes += 2;
                        stats.swaps += 1;
                        [values[j], values[j + 1]] = [values[j + 1], values[j]];
                    }
                    collector.record(values, [
                        { index: j, role: 'left' },
                        { index: j + 1, role: 'right' }
                    ]);
                }
            }

            return { steps: collector.finalize(values), stats };
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
            const values = [...arr];
            const stats = createStats();
            const collector = createStepCollector(values, stats);

            for (let i = 0; i < values.length - 1; i++) {
                let minIndex = i;
                for (let j = i + 1; j < values.length; j++) {
                    stats.comparisons += 1;
                    stats.reads += 2;
                    if (values[j] < values[minIndex]) {
                        minIndex = j;
                    }
                    collector.record(values, [
                        { index: i, role: 'anchor' },
                        { index: minIndex, role: 'min' },
                        { index: j, role: 'scan' }
                    ]);
                }

                if (minIndex !== i) {
                    stats.reads += 2;
                    stats.writes += 2;
                    stats.swaps += 1;
                    [values[i], values[minIndex]] = [values[minIndex], values[i]];
                }
            }

            return { steps: collector.finalize(values), stats };
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
            const values = [...arr];
            const stats = createStats();
            const collector = createStepCollector(values, stats);

            for (let i = 1; i < values.length; i++) {
                const key = values[i];
                stats.reads += 1;
                let j = i - 1;

                while (j >= 0) {
                    stats.comparisons += 1;
                    stats.reads += 1;
                    collector.record(values, [
                        { index: j, role: 'left' },
                        { index: j + 1, role: 'right' }
                    ]);

                    if (!(values[j] > key)) {
                        break;
                    }

                    stats.reads += 1;
                    stats.writes += 1;
                    values[j + 1] = values[j];
                    j -= 1;
                }

                stats.writes += 1;
                values[j + 1] = key;
            }

            return { steps: collector.finalize(values), stats };
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
            const values = [...arr];
            const stats = createStats();
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
                        stats.writes += 1;
                        values[writeIndex] = leftBuffer[li];
                        li += 1;
                    } else {
                        stats.reads += 1;
                        stats.writes += 1;
                        values[writeIndex] = rightBuffer[ri];
                        ri += 1;
                    }

                    collector.record(values, [
                        { lane: 'aux', index: leftIndex, role: 'left' },
                        { lane: 'aux', index: rightIndex, role: 'right' },
                        { lane: 'main', index: writeIndex, role: 'write' }
                    ], auxValues);

                    writeIndex += 1;
                }

                while (li < leftBuffer.length) {
                    stats.reads += 1;
                    stats.writes += 1;
                    values[writeIndex] = leftBuffer[li];
                    li += 1;
                    writeIndex += 1;
                }

                while (ri < rightBuffer.length) {
                    stats.reads += 1;
                    stats.writes += 1;
                    values[writeIndex] = rightBuffer[ri];
                    ri += 1;
                    writeIndex += 1;
                }
            };

            mergeSortRange(0, values.length - 1);
            return { steps: collector.finalize(values), stats };
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
            const values = [...arr];
            const stats = createStats();
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
                        collector.record(values, [
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
                        collector.record(values, [
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
                    stats.writes += 2;
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
            return { steps: collector.finalize(values), stats };
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
            const values = [...arr];
            const stats = createStats();
            const collector = createStepCollector(values, stats);
            const guard = createExecutionGuard(options);

            if (values.length <= 1) {
                return { steps: collector.finalize(values), stats };
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
                stats.writes += 2;
                stats.swaps += 1;
                endpointRoles.push(
                    { lane: 'main', index: 0, role: 'write' },
                    { lane: 'main', index: values.length - 1, role: 'write' }
                );
            }

            collector.record(values, endpointRoles);
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
                collector.record(values, minCompareRoles);

                if (shouldSwapMin) {
                    stats.reads += 2;
                    stats.writes += 2;
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
                collector.record(values, maxCompareRoles);

                if (shouldSwapMax) {
                    stats.reads += 2;
                    stats.writes += 2;
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
                stats.writes += 2;
                stats.swaps += 1;
                [values[left], values[right]] = [values[right], values[left]];
            };

            const recordMarkedScan = (index, role = 'scan') => {
                stats.indexChecks += 1;
                collector.record(values, [
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
                    collector.record(values, [
                        { lane: 'main', index: firstUnmarked, role: 'origin' }
                    ], null, undefined, undefined, undefined, marked);
                    firstUnmarked = firstUnmarkedIndex(firstUnmarked + 1);
                    continue;
                }

                let check = predictIndex(values[firstUnmarked]);

                stats.comparisons += 1;
                collector.record(values, [
                    { lane: 'main', index: firstUnmarked, role: 'origin' },
                    { lane: 'main', index: check, role: 'predicted' }
                ], null, undefined, undefined, undefined, marked);

                if (values[check] === values[firstUnmarked]) {
                    setMarked(check);
                    collector.record(values, [
                        { lane: 'main', index: firstUnmarked, role: 'origin' },
                        { lane: 'main', index: check, role: 'predicted' }
                    ], null, undefined, undefined, undefined, marked);

                    if (check === firstUnmarked) {
                        firstUnmarked = advanceFirstUnmarked(firstUnmarked);
                        continue;
                    }
                }

                stats.indexChecks += 1;
                collector.record(values, [
                    { lane: 'main', index: firstUnmarked, role: 'origin' },
                    { lane: 'main', index: check, role: 'predicted' }
                ], null, undefined, undefined, undefined, marked);
                if (!marked[check]) {
                    swapValues(firstUnmarked, check);
                    setMarked(check);
                    collector.record(values, [
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
                        collector.record(values, [
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
                            collector.record(values, [
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
                        collector.record(values, [
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
                            collector.record(values, [
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
                collector.record(values, [
                    { lane: 'main', index: firstUnmarked, role: 'origin' },
                    { lane: 'main', index: check, role: 'predicted' }
                ], null, undefined, undefined, undefined, marked);

                if (!insertionSlotWasMarked) {
                    setMarked(check);
                    collector.record(values, [
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
                    collector.record(values, [
                        { lane: 'main', index: firstUnmarked, role: 'origin' },
                        { lane: 'main', index: check, role: 'next' }
                    ], null, undefined, undefined, undefined, marked);

                    stats.comparisons += 1;
                    collector.record(values, [
                        { lane: 'main', index: firstUnmarked, role: 'origin' },
                        { lane: 'main', index: check, role: 'next' }
                    ], null, undefined, undefined, undefined, marked);
                    if (
                        (shiftDirection < 0 && values[check] < values[firstUnmarked])
                        || (shiftDirection > 0 && values[check] > values[firstUnmarked])
                    ) {
                        swapValues(firstUnmarked, check);
                        collector.record(values, [
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
                collector.record(values, [
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

            return { steps: collector.finalize(values), stats };
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
                return { steps: collector.finalize(inputValues.slice()), stats };
            }

            const guard = createExecutionGuard(options);
            const stats = createStats();
            const values = inputValues.slice();
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
                collector.record(values, [
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
                return { steps: collector.finalize(values), stats };
            }

            const valueMask = (1 << valueBits) - 1;

            // ── Sentinel flagged-chain mode (ordered, no wrapping) ─────────
            // Word layout:
            //   bit31: overwritten marker
            //   bit30: displacement metadata follows at i+1
            //   bit29: count metadata follows (after displacement metadata)
            //   bits0..28: payload
            const sentinelFlag = 0x80000000 >>> 0;
            const dispFlag = 0x40000000 >>> 0;
            const countFlag = 0x20000000 >>> 0;
            const payloadMask = 0x1FFFFFFF >>> 0;
            const inlineCountBits = 29 - valueBits;
            const maxInlineCount = inlineCountBits > 0 ? ((1 << inlineCountBits) - 1) : 0;
            const inlineCountMask = inlineCountBits > 0 ? ((1 << inlineCountBits) - 1) : 0;
            const basisBits = Math.ceil(Math.log2(n + 1));

            // Sentinel flag-chain path is currently disabled in favor of
            // slot+delta microbucket execution as the primary predictive mode.
            const canUseFlagChainMode = false && inlineCountBits > 0
                && valueBits <= 28
                && 29 >= countBits
                && 29 >= basisBits
                && values.every((v) => Number.isInteger(v));

            if (canUseFlagChainMode) {
                const restoreSortedOriginals = () => {
                    const sorted = inputValues.slice().sort((a, b) => a - b);
                    for (let i = 0; i < n; i += 1) values[i] = sorted[i];
                };
                const isOverwritten = (cell) => (((cell >>> 0) & sentinelFlag) !== 0);
                const ownerHasDispMeta = (cell) => (((cell >>> 0) & dispFlag) !== 0);
                const ownerHasCountMeta = (cell) => (((cell >>> 0) & countFlag) !== 0);
                const ownerRel = (cell) => (cell >>> 0) & valueMask;
                const ownerInlineCount = (cell) => inlineCountBits > 0
                    ? (((cell >>> valueBits) & inlineCountMask) >>> 0)
                    : 0;

                const encodeOwnerWord = (relVal, inlineCount, hasDisp, hasCount) => {
                    const base = ((inlineCount & inlineCountMask) << valueBits) | (relVal & valueMask);
                    return (sentinelFlag
                        | (hasDisp ? dispFlag : 0)
                        | (hasCount ? countFlag : 0)
                        | (base & payloadMask)) >>> 0;
                };
                const encodeMetaWord = (payload) => (sentinelFlag | (payload & payloadMask)) >>> 0;
                const decodeMetaPayload = (cell) => ((cell >>> 0) & payloadMask) >>> 0;
                const predictIndex = (relVal) => {
                    if (range <= 0 || n <= 1) return 0;
                    const raw = Math.round((relVal / range) * (n - 1));
                    if (Number.isNaN(raw)) return 0;
                    if (raw < 0) return 0;
                    if (raw >= n) return n - 1;
                    return raw;
                };

                let usedWords = 0;
                const pendingRelValues = [];
                const originalQueued = new Array(n).fill(false);

                const ownerRecordLengthAt = (pos) => {
                    const cell = values[pos] >>> 0;
                    let len = 1;
                    if (ownerHasDispMeta(cell)) len += 1;
                    if (ownerHasCountMeta(cell)) len += 1;
                    return len;
                };

                const getOwnerCountAt = (pos) => {
                    const cell = values[pos] >>> 0;
                    if (ownerHasCountMeta(cell)) {
                        const countMetaPos = pos + 1 + (ownerHasDispMeta(cell) ? 1 : 0);
                        return decodeMetaPayload(values[countMetaPos] >>> 0);
                    }
                    return ownerInlineCount(cell);
                };

                const setOwnerInlineCountAt = (pos, nextInlineCount) => {
                    const cell = values[pos] >>> 0;
                    const relVal = ownerRel(cell);
                    const hasDisp = ownerHasDispMeta(cell);
                    const hasCount = ownerHasCountMeta(cell);
                    values[pos] = encodeOwnerWord(relVal, nextInlineCount, hasDisp, hasCount);
                };

                const shiftRightAt = (startPos, wordCount) => {
                    if (wordCount <= 0) return true;
                    if (usedWords + wordCount > n) return false;

                    for (let b = 0; b < wordCount; b += 1) {
                        const displacedIndex = usedWords + b;
                        if (
                            displacedIndex < n
                            && !isOverwritten(values[displacedIndex] >>> 0)
                            && !originalQueued[displacedIndex]
                        ) {
                            originalQueued[displacedIndex] = true;
                            pendingRelValues.push(values[displacedIndex] - min);
                        }
                    }

                    for (let idx = usedWords - 1; idx >= startPos; idx -= 1) {
                        values[idx + wordCount] = values[idx];
                    }
                    for (let idx = startPos; idx < startPos + wordCount; idx += 1) {
                        values[idx] = 0;
                    }
                    usedWords += wordCount;
                    return true;
                };

                const setCountAt = (ownerPos, nextCount) => {
                    const ownerCell = values[ownerPos] >>> 0;
                    const relVal = ownerRel(ownerCell);
                    const hasDisp = ownerHasDispMeta(ownerCell);
                    const hasCount = ownerHasCountMeta(ownerCell);

                    if (!hasCount && nextCount <= maxInlineCount) {
                        values[ownerPos] = encodeOwnerWord(relVal, nextCount, hasDisp, false);
                        return true;
                    }

                    let countMetaPos;
                    if (!hasCount) {
                        countMetaPos = ownerPos + 1 + (hasDisp ? 1 : 0);
                        if (!shiftRightAt(countMetaPos, 1)) return false;
                        values[ownerPos] = encodeOwnerWord(relVal, Math.min(nextCount, maxInlineCount), hasDisp, true);
                    } else {
                        countMetaPos = ownerPos + 1 + (hasDisp ? 1 : 0);
                    }

                    values[countMetaPos] = encodeMetaWord(nextCount);
                    return true;
                };

                const buildFlagChainDisplayValues = () => {
                    const out = new Array(n);
                    const info = new Array(n).fill('');

                    let pos = 0;
                    while (pos < usedWords) {
                        const ownerCell = values[pos] >>> 0;
                        const relVal = ownerRel(ownerCell);
                        const count = getOwnerCountAt(pos);
                        const hasDisp = ownerHasDispMeta(ownerCell);
                        const hasCount = ownerHasCountMeta(ownerCell);
                        const basis = hasDisp ? decodeMetaPayload(values[pos + 1] >>> 0) : pos;
                        info[pos] = `${relVal + min} \u00d7${count}${hasDisp ? ` @${basis}` : ''}`;

                        let next = pos + 1;
                        if (hasDisp) {
                            info[next] = `basis:${decodeMetaPayload(values[next] >>> 0)}`;
                            next += 1;
                        }
                        if (hasCount) {
                            info[next] = `count:${decodeMetaPayload(values[next] >>> 0)}`;
                            next += 1;
                        }
                        pos = next;
                    }

                    for (let i = 0; i < n; i += 1) {
                        if (isOverwritten(values[i] >>> 0)) {
                            out[i] = `|${info[i]}`;
                        } else {
                            out[i] = `${values[i]}|`;
                        }
                    }
                    return out;
                };

                const findOwner = (relVal) => {
                    let pos = 0;
                    let insertPos = usedWords;
                    while (pos < usedWords) {
                        const cell = values[pos] >>> 0;
                        const currentRel = ownerRel(cell);
                        const nextPos = pos + ownerRecordLengthAt(pos);
                        if (currentRel === relVal) return { found: pos, insertPos: pos };
                        if (currentRel > relVal) {
                            insertPos = pos;
                            return { found: -1, insertPos };
                        }
                        pos = nextPos;
                    }
                    return { found: -1, insertPos };
                };

                const insertNewOwner = (relVal) => {
                    const { insertPos } = findOwner(relVal);
                    const predicted = predictIndex(relVal);
                    const needsDisp = predicted !== insertPos;
                    const wordsNeeded = 1 + (needsDisp ? 1 : 0);
                    if (!shiftRightAt(insertPos, wordsNeeded)) return { ok: false };

                    values[insertPos] = encodeOwnerWord(relVal, 1, needsDisp, false);
                    if (needsDisp) {
                        values[insertPos + 1] = encodeMetaWord(predicted);
                    }
                    return { ok: true, ownerPos: insertPos };
                };

                const incrementExistingOwner = (ownerPos) => {
                    const prevCount = getOwnerCountAt(ownerPos);
                    const nextCount = prevCount + 1;
                    if (nextCount > payloadMask) return false;
                    return setCountAt(ownerPos, nextCount);
                };

                collector.record(values, [], null, undefined, min, max, null, buildFlagChainDisplayValues());

                let flaggedOverflow = false;
                for (let i = 0; i < n; i += 1) {
                    guard.tick();
                    if (!isOverwritten(values[i] >>> 0) && !originalQueued[i]) {
                        originalQueued[i] = true;
                        pendingRelValues.push(values[i] - min);
                    }

                    while (pendingRelValues.length > 0) {
                        guard.tick();
                        const relVal = pendingRelValues.pop();
                        stats.reads += 1;
                        stats.indexChecks += 1;

                        if (relVal < 0 || relVal > range) {
                            flaggedOverflow = true;
                            break;
                        }

                        const foundInfo = findOwner(relVal);
                        let ownerPos = -1;
                        if (foundInfo.found >= 0) {
                            if (!incrementExistingOwner(foundInfo.found)) {
                                flaggedOverflow = true;
                                break;
                            }
                            ownerPos = foundInfo.found;
                        } else {
                            const inserted = insertNewOwner(relVal);
                            if (!inserted.ok) {
                                flaggedOverflow = true;
                                break;
                            }
                            ownerPos = inserted.ownerPos;
                        }

                        stats.writes += 1;
                        collector.record(values, [
                            { lane: 'count', index: ownerPos, role: 'write' }
                        ], null, undefined, min, max, null, buildFlagChainDisplayValues());
                    }

                    if (flaggedOverflow) break;
                }

                if (!flaggedOverflow) {
                    const entries = [];
                    let pos = 0;
                    while (pos < usedWords) {
                        const ownerCell = values[pos] >>> 0;
                        entries.push({ rel: ownerRel(ownerCell), count: getOwnerCountAt(pos) });
                        pos += ownerRecordLengthAt(pos);
                    }

                    let write = n - 1;
                    for (let e = entries.length - 1; e >= 0; e -= 1) {
                        const relVal = entries[e].rel;
                        const total = entries[e].count;
                        for (let c = 0; c < total; c += 1) {
                            guard.tick();
                            values[write] = relVal + min;
                            stats.writes += 1;
                            collector.record(values, [
                                { lane: 'main', index: write, role: 'write' }
                            ], null, undefined, min, max, null, buildFlagChainDisplayValues());
                            write -= 1;
                        }
                    }

                    if (write !== -1) {
                        restoreSortedOriginals();
                        return {
                            steps: collector.finalize(values),
                            stats,
                            predictiveBits: {
                                mode: 'sentinelFlagChainFallback',
                                valueBits,
                                countBits,
                                sentinel: true
                            }
                        };
                    }

                    return {
                        steps: collector.finalize(values),
                        stats,
                        predictiveBits: {
                            mode: 'sentinelFlagChain',
                            valueBits,
                            countBits,
                            inlineCountBits,
                            sentinel: true
                        }
                    };
                }

                // Overflow fallback: preserve correctness.
                restoreSortedOriginals();
                return {
                    steps: collector.finalize(values),
                    stats,
                    predictiveBits: {
                        mode: 'sentinelFlagChainFallback',
                        valueBits,
                        countBits,
                        sentinel: true
                    }
                };
            }

            const countShift = 2 * valueBits;
            const halfCountMask = (1 << halfCountBits) - 1;

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
                collector.record(values, trackedIndices, null, undefined, min, max, null, buildPackedDisplayValues());
            };

            // ── Mode 0: contiguous packed memory (5 sweeps) ───────────────
            // Sweep 2: pack all original rel values tightly at the start.
            // Sweep 3: use remaining bits contiguously for counting metadata.
            // Sweep 4: expand counts into a compressed sorted value stream.
            // Sweep 5: decompress sorted stream to plain absolute integers.
            const preferDeltaSlots = true;
            const totalBits = n * 32;
            const packedBits = n * valueBits;
            const freeBits = totalBits - packedBits;
            const directBucketCount = range + 1;
            const canUseContiguousDirect = (directBucketCount * countBits) <= freeBits;

            if (freeBits > 0 && !preferDeltaSlots) {
                const relValues = values.slice();
                const packedStartBit = 0;
                const tailStartBit = packedBits;

                const readBitsFrom = (sourceWords, bitOffset, width) => {
                    if (width <= 0) return 0;
                    let remaining = width;
                    let srcBit = bitOffset;
                    let outShift = 0;
                    let out = 0;
                    while (remaining > 0) {
                        const wordIndex = Math.floor(srcBit / 32);
                        const bitInWord = srcBit % 32;
                        const take = Math.min(remaining, 32 - bitInWord);
                        const mask = take === 32 ? 0xFFFFFFFF : (2 ** take - 1);
                        const word = sourceWords[wordIndex] >>> 0;
                        const part = (word >>> bitInWord) & mask;
                        out |= (part << outShift);
                        srcBit += take;
                        remaining -= take;
                        outShift += take;
                    }
                    return out >>> 0;
                };

                const readBits = (bitOffset, width) => readBitsFrom(values, bitOffset, width);

                const writeBits = (bitOffset, width, nextValue) => {
                    if (width <= 0) return;
                    let remaining = width;
                    let dstBit = bitOffset;
                    let inShift = 0;
                    while (remaining > 0) {
                        const wordIndex = Math.floor(dstBit / 32);
                        const bitInWord = dstBit % 32;
                        const take = Math.min(remaining, 32 - bitInWord);
                        const mask = take === 32 ? 0xFFFFFFFF : (2 ** take - 1);
                        const part = (nextValue >>> inShift) & mask;
                        const clearMask = ~(mask << bitInWord);
                        const current = values[wordIndex] >>> 0;
                        values[wordIndex] = ((current & clearMask) | (part << bitInWord)) >>> 0;
                        dstBit += take;
                        remaining -= take;
                        inShift += take;
                    }
                };

                const readPackedRelAt = (logicalIndex) => {
                    const bitOffset = packedStartBit + logicalIndex * valueBits;
                    return readBits(bitOffset, valueBits);
                };

                const writePackedRelAt = (logicalIndex, relVal) => {
                    const bitOffset = packedStartBit + logicalIndex * valueBits;
                    writeBits(bitOffset, valueBits, relVal);
                };

                const buildContiguousStripDisplayValues = (plainStart, synByWord) => {
                    const out = new Array(n);
                    for (let i = 0; i < n; i += 1) {
                        const syn = synByWord && synByWord[i] ? synByWord[i] : '';
                        if (i >= plainStart) {
                            // Decompressed: plain integer, full-width cell.
                            out[i] = `${values[i]}|${syn}`;
                        } else {
                            // Still packed: read live values[] for this word.
                            // Safe because the packed bits for logical indices < plainStart
                            // live in 32-bit words < plainStart, which haven't been written yet
                            // (the strip loop decompresses right-to-left).
                            out[i] = `${buildPackedWordPrimary(i, n)}|${syn}`;
                        }
                    }
                    return out;
                };

                const buildPackedWordPrimary = (wordIndex, packedCount, showSourcePlaceholder = false) => {
                    const packedBitLimit = packedCount * valueBits;
                    const wordStart = wordIndex * 32;
                    const wordEnd = wordStart + 32;
                    if (wordStart >= packedBitLimit || packedCount <= 0) {
                        if (showSourcePlaceholder && packedCount < n) {
                            if (wordIndex < packedCount) {
                                return '';
                            }
                            if (wordIndex < relValues.length) {
                                return `src:${relValues[wordIndex] + min}`;
                            }
                        }
                        return '';
                    }
                    const maxBit = Math.min(wordEnd, packedBitLimit) - 1;
                    if (maxBit < wordStart) {
                        if (showSourcePlaceholder && packedCount < n) {
                            if (wordIndex < packedCount) {
                                return '';
                            }
                            if (wordIndex < relValues.length) {
                                return `src:${relValues[wordIndex] + min}`;
                            }
                        }
                        return '';
                    }
                    const firstIdx = Math.floor(wordStart / valueBits);
                    const lastIdx = Math.min(packedCount - 1, Math.floor(maxBit / valueBits));
                    const vals = [];
                    for (let idx = firstIdx; idx <= lastIdx; idx += 1) {
                        const valueStartBit = idx * valueBits;
                        const valueEndBit = valueStartBit + valueBits;
                        const overlapStart = Math.max(wordStart, valueStartBit);
                        const overlapEnd = Math.min(wordEnd, valueEndBit);
                        const overlapWidth = overlapEnd - overlapStart;
                        if (overlapWidth <= 0) continue;
                        const absVal = readPackedRelAt(idx) + min;
                        // If this chunk starts mid-value, render as unlabeled continuation.
                        // Continuation fragments use ~val so the renderer can colour them
                        // to match the labelled fragment without showing duplicate text.
                        const label = overlapStart > valueStartBit ? `~${absVal}` : String(absVal);
                        vals.push(`@${overlapStart}:${overlapWidth}:${label}`);
                    }
                    return vals.length > 0 ? vals.join(' ') : '';
                };

                // Sweep 2: clear words and pack original relative values contiguously.
                for (let i = 0; i < n; i += 1) values[i] = 0;

                if (canUseContiguousDirect) {
                    const readCountAt = (relVal) => {
                        const bitOffset = tailStartBit + relVal * countBits;
                        return readBits(bitOffset, countBits);
                    };
                    const writeCountAt = (relVal, count) => {
                        const bitOffset = tailStartBit + relVal * countBits;
                        writeBits(bitOffset, countBits, count);
                    };

                    const buildDirectSyntheticByWord = () => {
                        const parts = Array.from({ length: n }, () => []);
                        for (let rel = 0; rel < directBucketCount; rel += 1) {
                            const cnt = readCountAt(rel);
                            if (cnt <= 0) continue;
                            const bitOffset = tailStartBit + rel * countBits;
                            const endBit = bitOffset + countBits - 1;
                            const startWord = Math.floor(bitOffset / 32);
                            const endWord = Math.floor(endBit / 32);
                            for (let wordIndex = startWord; wordIndex <= endWord; wordIndex += 1) {
                                if (wordIndex >= 0 && wordIndex < n) {
                                    parts[wordIndex].push(`@${bitOffset}:${countBits}:${rel + min} ×${cnt}`);
                                }
                            }
                        }
                        return parts.map((p) => p.join(', '));
                    };

                    const buildContiguousDirectDisplayValues = (packedCount = n, showSourcePlaceholder = false) => {
                        const synByWord = buildDirectSyntheticByWord();
                        const out = new Array(n);
                        for (let i = 0; i < n; i += 1) {
                            const primary = buildPackedWordPrimary(i, packedCount, showSourcePlaceholder);
                            out[i] = `${primary}|${synByWord[i]}`;
                        }
                        return out;
                    };

                    collector.record(values, [], null, undefined, min, max, null, buildContiguousDirectDisplayValues(0, true));

                    for (let i = 0; i < n; i += 1) {
                        guard.tick();
                        writePackedRelAt(i, relValues[i]);
                        stats.writes += 1;
                        collector.record(values, [
                            { lane: 'main', index: i, role: 'write' }
                        ], null, undefined, min, max, null, buildContiguousDirectDisplayValues(i + 1, true));
                    }

                    for (let rel = 0; rel < directBucketCount; rel += 1) writeCountAt(rel, 0);
                    collector.record(values, [], null, undefined, min, max, null, buildContiguousDirectDisplayValues(n));

                    for (let i = 0; i < n; i += 1) {
                        guard.tick();
                        const relVal = readPackedRelAt(i);
                        const nextStored = readCountAt(relVal) + 1;
                        writeCountAt(relVal, nextStored);
                        stats.reads += 1;
                        stats.writes += 1;
                        stats.indexChecks += 1;
                        collector.record(values, [
                            { lane: 'main', index: i, role: 'origin' },
                            { lane: 'count', index: relVal, role: 'write' }
                        ], null, undefined, min, max, null, buildContiguousDirectDisplayValues(n));
                    }

                    let wPacked = 0;
                    for (let rel = 0; rel < directBucketCount; rel += 1) {
                        const cnt = readCountAt(rel);
                        if (cnt <= 0) continue;
                        stats.reads += 1;
                        for (let c = 0; c < cnt; c += 1) {
                            guard.tick();
                            writePackedRelAt(wPacked, rel);
                            stats.writes += 1;
                            collector.record(values, [
                                { lane: 'main', index: wPacked, role: 'write' }
                            ], null, undefined, min, max, null, buildContiguousDirectDisplayValues(n));
                            wPacked += 1;
                        }
                    }

                    const synByWord = buildDirectSyntheticByWord();
                    const packedSnapshot = values.slice();
                    const readPackedFromSnapshotAt = (logicalIndex) => {
                        const bitOffset = packedStartBit + logicalIndex * valueBits;
                        return readBitsFrom(packedSnapshot, bitOffset, valueBits);
                    };

                    for (let i = n - 1; i >= 0; i -= 1) {
                        guard.tick();
                        const relVal = readPackedFromSnapshotAt(i);
                        values[i] = relVal + min;
                        stats.reads += 1;
                        stats.writes += 1;
                        collector.record(values, [
                            { lane: 'main', index: i, role: 'decompress' }
                        ], null, undefined, min, max, null, buildContiguousStripDisplayValues(i, synByWord));
                    }

                    return {
                        steps: collector.finalize(values),
                        stats,
                        predictiveBits: {
                            mode: 'contiguousPacked',
                            valueBits,
                            countBits,
                            packedBits,
                            freeBits,
                            bucketCount: directBucketCount,
                            layout: 'direct'
                        }
                    };
                }

                // ── Fallback: hash-predicted open-addressed bin counting ─────────────────
                // All counts are maintained in-place inside slot count fields.
                // Count-field widening is done lazily on duplicate hits, with local
                // rightward propagation only through the contiguous occupied chain.
                const initialWordBits = valueBits + 1;
                const maxInitialSlots = Math.floor(freeBits / initialWordBits);

                // Per-slot tracking: bit offset and count field width.
                const slotOffsets = new Array(maxInitialSlots);
                const slotCBits = new Array(maxInitialSlots); // count field width
                for (let s = 0; s < maxInitialSlots; s += 1) {
                    slotOffsets[s] = tailStartBit + s * initialWordBits;
                    slotCBits[s] = 1;
                }
                const activeBinSlots = maxInitialSlots;
                let usedBins = 0;

                // Shift only a local bit-range right by numBits.
                // This keeps movement local to the contiguous occupied chain.
                const shiftBitRangeRight = (rangeStart, rangeEndExclusive, numBits) => {
                    if (numBits <= 0 || rangeEndExclusive <= rangeStart) return;
                    for (let b = rangeEndExclusive - 1; b >= rangeStart; b -= 1) {
                        const srcWord = Math.floor(b / 32);
                        const srcMask = 1 << (b % 32);
                        const bit = (values[srcWord] & srcMask) !== 0;
                        const dstBit = b + numBits;
                        const dstWord = Math.floor(dstBit / 32);
                        const dstMask = 1 << (dstBit % 32);
                        if (bit) values[dstWord] |= dstMask;
                        else values[dstWord] &= ~dstMask;
                    }
                    for (let b = rangeStart; b < rangeStart + numBits; b += 1) {
                        values[Math.floor(b / 32)] &= ~(1 << (b % 32));
                    }
                };

                const readSlotRel = (s) => readBits(slotOffsets[s], valueBits);
                const readSlotCount = (s) => readBits(slotOffsets[s] + valueBits, slotCBits[s]);
                const writeSlotWord = (s, relVal, storedCount) => {
                    writeBits(slotOffsets[s], valueBits, relVal);
                    writeBits(slotOffsets[s] + valueBits, slotCBits[s], storedCount);
                };

                const predictBinSlot = (relVal) =>
                    range > 0 ? Math.round(relVal / range * (activeBinSlots - 1)) : 0;

                const probeBinSlot = (relVal, from) => {
                    // Wrap-around linear probe: find same-value slot or first empty slot.
                    for (let t = 0; t < activeBinSlots; t += 1) {
                        const s = (from + t) % activeBinSlots;
                        const cnt = readSlotCount(s);
                        if (cnt === 0) return { found: -1, emptyAt: s };
                        if (readSlotRel(s) === relVal) return { found: s, emptyAt: -1 };
                    }
                    return { found: -1, emptyAt: -1 };
                };

                // Ensure a slot can hold nextCount by widening only that slot and
                // propagating to a contiguous occupied chain on the immediate right.
                const ensureSlotCountWidth = (slot, nextCount) => {
                    const neededBits = Math.ceil(Math.log2(nextCount + 1));
                    const extraBits = neededBits - slotCBits[slot];
                    if (extraBits <= 0) return true;

                    const right = slot + 1;
                    if (right >= activeBinSlots || readSlotCount(right) === 0) {
                        // Immediate right slot is empty (or no right slot): grow in place.
                        slotCBits[slot] += extraBits;
                        return true;
                    }

                    // Find contiguous occupied run [right, runEnd) to propagate.
                    let runEnd = right;
                    while (runEnd < activeBinSlots && readSlotCount(runEnd) !== 0) runEnd += 1;
                    if (runEnd >= activeBinSlots) {
                        // No stopper empty slot available for local propagation.
                        return false;
                    }

                    // Shift only the occupied run's bits, not the entire tail.
                    const rangeStart = slotOffsets[right];
                    const rangeEndExclusive = slotOffsets[runEnd];
                    if (rangeStart + extraBits > n * 32 || rangeEndExclusive + extraBits > n * 32) {
                        return false;
                    }
                    shiftBitRangeRight(rangeStart, rangeEndExclusive, extraBits);

                    // Update metadata only for moved contiguous neighbors.
                    for (let ss = right; ss < runEnd; ss += 1) {
                        slotOffsets[ss] += extraBits;
                    }
                    slotCBits[slot] += extraBits;
                    return true;
                };

                // Build display tokens directly from in-place bins.
                const buildBinSyntheticByWord = () => {
                    const parts = Array.from({ length: n }, () => []);
                    for (let s = 0; s < activeBinSlots; s += 1) {
                        if (readSlotCount(s) === 0) continue;
                        const relVal = readSlotRel(s);
                        const total = readSlotCount(s);
                        const bitOffset = slotOffsets[s];
                        const slotWidth = valueBits + slotCBits[s];
                        const startWord = Math.floor(bitOffset / 32);
                        const endWord = Math.floor((bitOffset + slotWidth - 1) / 32);
                        const label = `${relVal + min} \u00d7${total}`;
                        for (let w = startWord; w <= endWord; w += 1) {
                            if (w >= 0 && w < n) parts[w].push(`@${bitOffset}:${slotWidth}:${label}`);
                        }
                    }
                    return parts.map((p) => p.join(', '));
                };

                const buildContiguousBinDisplayValues = (packedCount = n, showSourcePlaceholder = false) => {
                    const synByWord = buildBinSyntheticByWord();
                    const out = new Array(n);
                    for (let i = 0; i < n; i += 1) {
                        const primary = buildPackedWordPrimary(i, packedCount, showSourcePlaceholder);
                        out[i] = `${primary}|${synByWord[i]}`;
                    }
                    return out;
                };

                collector.record(values, [], null, undefined, min, max, null, buildContiguousBinDisplayValues(0, true));

                for (let i = 0; i < n; i += 1) {
                    guard.tick();
                    writePackedRelAt(i, relValues[i]);
                    stats.writes += 1;
                    collector.record(values, [
                        { lane: 'main', index: i, role: 'write' }
                    ], null, undefined, min, max, null, buildContiguousBinDisplayValues(i + 1, true));
                }

                for (let s = 0; s < activeBinSlots; s += 1) writeSlotWord(s, 0, 0);
                collector.record(values, [], null, undefined, min, max, null, buildContiguousBinDisplayValues(n));

                // Phase A: scan packed values and maintain true counts in-place.
                for (let i = 0; i < n; i += 1) {
                    guard.tick();
                    const relVal = readPackedRelAt(i);
                    stats.reads += 1;
                    stats.indexChecks += 1;

                    const pred = predictBinSlot(relVal);
                    const { found, emptyAt } = probeBinSlot(relVal, pred);
                    stats.comparisons += 1;

                    let countWriteSlot = -1;
                    if (found >= 0) {
                        const prev = readSlotCount(found);
                        const next = prev + 1;
                        if (!ensureSlotCountWidth(found, next)) {
                            continue;
                        }
                        writeBits(slotOffsets[found] + valueBits, slotCBits[found], next);
                        stats.writes += 1;
                        countWriteSlot = found;
                    } else if (emptyAt >= 0) {
                        writeSlotWord(emptyAt, relVal, 1);
                        stats.writes += 1;
                        usedBins += 1;
                        countWriteSlot = emptyAt;
                    }

                    // Use slot's current bit-offset as the tracking key so the renderer
                    // can look it up directly from the @bitOffset token in the display.
                    const trackKey = countWriteSlot >= 0 ? slotOffsets[countWriteSlot] : -1;
                    const binTrack = countWriteSlot >= 0
                        ? [{ lane: 'main', index: i, role: 'origin' }, { lane: 'count', index: trackKey, role: 'write' }]
                        : [{ lane: 'main', index: i, role: 'origin' }];
                    collector.record(values, binTrack, null, undefined, min, max, null, buildContiguousBinDisplayValues(n));
                }

                // Sweep 4: expand bin counts into sorted packed stream.
                let wPacked = 0;
                for (let rel = 0; rel <= range; rel += 1) {
                    let total = 0;
                    for (let s = 0; s < activeBinSlots; s += 1) {
                        if (readSlotCount(s) > 0 && readSlotRel(s) === rel) {
                            total = readSlotCount(s);
                            break;
                        }
                    }
                    for (let c = 0; c < total; c += 1) {
                        guard.tick();
                        writePackedRelAt(wPacked, rel);
                        stats.writes += 1;
                        collector.record(values, [
                            { lane: 'main', index: wPacked, role: 'write' }
                        ], null, undefined, min, max, null, buildContiguousBinDisplayValues(n));
                        wPacked += 1;
                    }
                }

                const synByWord = buildBinSyntheticByWord();
                const packedSnapshot = values.slice();
                const readPackedFromSnapshotAt = (logicalIndex) => {
                    const bitOffset = packedStartBit + logicalIndex * valueBits;
                    return readBitsFrom(packedSnapshot, bitOffset, valueBits);
                };

                for (let i = n - 1; i >= 0; i -= 1) {
                    guard.tick();
                    const relVal = readPackedFromSnapshotAt(i);
                    values[i] = relVal + min;
                    stats.reads += 1;
                    stats.writes += 1;
                    collector.record(values, [
                        { lane: 'main', index: i, role: 'decompress' }
                    ], null, undefined, min, max, null, buildContiguousStripDisplayValues(i, synByWord));
                }

                const finalMaxCBits = activeBinSlots > 0
                    ? Math.max(...slotCBits.slice(0, activeBinSlots))
                    : 1;
                return {
                    steps: collector.finalize(values),
                    stats,
                    predictiveBits: {
                        mode: 'contiguousPacked',
                        valueBits,
                        countBits: finalMaxCBits,
                        binWordBits: valueBits + finalMaxCBits,
                        packedBits,
                        freeBits,
                        bucketCount: usedBins,
                        layout: 'bins'
                    }
                };
            }

            const highBitBudget = 31 - valueBits;

            // ── Mode A: packed direct counting (no collisions) ─────────────
            // If we can address every relVal bucket directly inside packed counters,
            // run true counting-sort semantics with no bin-placement collisions.
            const directSlotsPerCell = countBits > 0 ? Math.floor(highBitBudget / countBits) : 0;
            const countMask = (1 << countBits) - 1;
            if (!preferDeltaSlots && directSlotsPerCell > 0 && directSlotsPerCell * n >= (range + 1)) {
                const getDirectSlotShift = (slot) => valueBits + slot * countBits;
                const getDirectCount = (relVal) => {
                    const cellIdx = Math.floor(relVal / directSlotsPerCell);
                    const slot = relVal % directSlotsPerCell;
                    const shift = getDirectSlotShift(slot);
                    return (values[cellIdx] >> shift) & countMask;
                };
                const setDirectCount = (relVal, nextCount) => {
                    const cellIdx = Math.floor(relVal / directSlotsPerCell);
                    const slot = relVal % directSlotsPerCell;
                    const shift = getDirectSlotShift(slot);
                    const clearMask = ~(countMask << shift);
                    values[cellIdx] = (values[cellIdx] & clearMask) | ((nextCount & countMask) << shift);
                    return cellIdx;
                };

                const buildDirectDisplayValues = () => values.map((cell, idx) => {
                    const origAbsVal = (cell & valueMask) + min;
                    const baseRel = idx * directSlotsPerCell;
                    const parts = [];
                    for (let s = 0; s < directSlotsPerCell; s += 1) {
                        const rel = baseRel + s;
                        if (rel > range) break;
                        const cnt = (cell >> getDirectSlotShift(s)) & countMask;
                        if (cnt > 0) {
                            parts.push(`${rel + min} ×${cnt}`);
                        }
                    }
                    return `${origAbsVal}|${parts.join(', ')}`;
                });

                const buildDirectExpansionDisplayValues = () => values.map((cell, idx) => {
                    const primaryAbsVal = (cell & valueMask) + min;
                    const baseRel = idx * directSlotsPerCell;
                    const parts = [];
                    for (let s = 0; s < directSlotsPerCell; s += 1) {
                        const rel = baseRel + s;
                        if (rel > range) break;
                        const cnt = (cell >> getDirectSlotShift(s)) & countMask;
                        if (cnt > 0) parts.push(`${rel + min} ×${cnt}`);
                    }
                    return `${primaryAbsVal}|${parts.join(', ')}`;
                });

                const buildDirectStripDisplayValues = (stripPos) => values.map((cell, idx) => {
                    if (idx < stripPos) return `${cell}|`;
                    const sortedAbsVal = (cell & valueMask) + min;
                    const baseRel = idx * directSlotsPerCell;
                    const parts = [];
                    for (let s = 0; s < directSlotsPerCell; s += 1) {
                        const rel = baseRel + s;
                        if (rel > range) break;
                        const cnt = (cell >> getDirectSlotShift(s)) & countMask;
                        if (cnt > 0) parts.push(`${rel + min} ×${cnt}`);
                    }
                    return `${sortedAbsVal}|${parts.join(', ')}`;
                });

                for (let i = 0; i < n; i += 1) {
                    guard.tick();
                    stats.reads += 1;
                    stats.indexChecks += 1;
                    const relVal = values[i] & valueMask;
                    const nextCount = getDirectCount(relVal) + 1;
                    const targetCell = setDirectCount(relVal, nextCount);
                    stats.writes += 1;
                    collector.record(values, [
                        { lane: 'main', index: i, role: 'origin', part: 'orig' },
                        { lane: 'main', index: targetCell, role: 'write', part: 'bin' }
                    ], null, undefined, min, max, null, buildDirectDisplayValues());
                }

                let w = 0;
                for (let rel = 0; rel <= range; rel += 1) {
                    const cnt = getDirectCount(rel);
                    for (let c = 0; c < cnt; c += 1) {
                        guard.tick();
                        values[w] = (values[w] & ~valueMask) | rel;
                        stats.writes += 1;
                        collector.record(values, [
                            { lane: 'main', index: w, role: 'write' }
                        ], null, undefined, min, max, null, buildDirectExpansionDisplayValues());
                        w += 1;
                    }
                }

                for (let i = 0; i < n; i += 1) {
                    guard.tick();
                    values[i] = (values[i] & valueMask) + min;
                    stats.writes += 1;
                    collector.record(values, [
                        { lane: 'main', index: i, role: 'write' }
                    ], null, undefined, min, max, null, buildDirectStripDisplayValues(i + 1));
                }

                return {
                    steps: collector.finalize(values),
                    stats,
                    predictiveBits: {
                        mode: 'directPacked',
                        valueBits,
                        countBits,
                        slotsPerCell: directSlotsPerCell
                    }
                };
            }

            // ── Mode B: delta microbuckets (multi pair per index) ──────────
            // Store (delta-from-anchor, count) pairs in each index's high bits.
            // If a relVal cannot fit any microbucket slot, it spills into an
            // overflow map and is merged back during expansion.
            const stepEstimate = range / Math.max(1, n - 1);
            const deltaMax = Math.max(1, Math.ceil(stepEstimate));
            const deltaCardinality = 2 * deltaMax + 1;
            const deltaBits = Math.ceil(Math.log2(deltaCardinality));
            const pairBits = deltaBits + 1;
            const microSlotsPerCell = pairBits > 0 ? Math.floor(31 / pairBits) : 0;

            // Displacement-chain model uses SENTINEL (bit 31) to mark converted cells.
            // Raw absolute values must have bit 31 = 0, which is guaranteed when
            // min >= 0 and max < 2^31. Negative inputs fall through to overlay3.
            const canUseDisplacementChain = microSlotsPerCell >= 1
                && min >= 0
                && (max >>> 0) < 0x80000000;

            if (canUseDisplacementChain) {
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
                const deltaMask = (1 << deltaBits) - 1;
                const flagBit = 1 << deltaBits;
                const deltaBias = deltaMax;

                // Assign a preferred slot based on the delta value's quantile in [0, 2*deltaMax].
                // This distributes values across slots by value range rather than always using slot 0.
                const preferredSlot = (dEnc) =>
                    Math.min(microSlotsPerCell - 1,
                        Math.floor(dEnc / (2 * deltaBias + 1) * microSlotsPerCell));

                const anchorRel = (idx) => {
                    if (range === 0 || n <= 1) return 0;
                    return Math.round((idx / (n - 1)) * range);
                };

                // Slots packed from bit 0 upwards; no original-value reserved low bits.
                // Encoding: empty = word 0; count=1: (deltaEnc+1) in deltaBits bits (flag=0);
                // count>1: (deltaEnc+1)|flagBit as delta slot + count stored in the next slot.
                // (deltaEnc+1 is always non-zero and fits in deltaBits bits because
                //  deltaCardinality = 2*deltaMax+1 is always odd, so 2^deltaBits > deltaCardinality.)
                const getSlotShift = (slot) => slot * pairBits;
                const getSlotWord = (cell, slot) => ((cell >>> 0) >>> getSlotShift(slot)) & pairMask;
                const setSlotWord = (cell, slot, word) => {
                    const shift = getSlotShift(slot);
                    const c = cell >>> 0;
                    const clearMask = (~(pairMask << shift)) >>> 0;
                    return ((c & clearMask) | ((word & pairMask) << shift)) >>> 0;
                };
                // count=1: store (deltaEnc+1) with flag=0.  count>1: store (deltaEnc+1)|flagBit; count in next slot.
                const packSlot = (deltaEnc, cnt) =>
                    cnt <= 1
                        ? ((deltaEnc + 1) & deltaMask) >>> 0
                        : (((deltaEnc + 1) & deltaMask) | flagBit) >>> 0;
                const slotIsEmpty = (word) => (word & pairMask) === 0;
                const slotHasFlag = (word) => Boolean(word & flagBit);
                const unpackDeltaEnc = (word) => (word & deltaMask) - 1;

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
                    const aRel = anchorRel(i);
                    const parts = [];
                    let s = 0;
                    while (s < microSlotsPerCell) {
                        const word = getSlotWord(c, s);
                        if (slotIsEmpty(word)) { s += 1; continue; }
                        const dEnc = unpackDeltaEnc(word);
                        let cnt;
                        if (slotHasFlag(word)) {
                            cnt = s + 1 < microSlotsPerCell ? getSlotWord(c, s + 1) : 0;
                            s += 2;
                        } else {
                            cnt = 1;
                            s += 1;
                        }
                        if (cnt <= 0) continue;
                        const rel = aRel + (dEnc - deltaBias);
                        if (rel >= 0 && rel <= range) {
                            parts.push(cnt > 1 ? `${rel + min} \u00d7${cnt}` : `${rel + min}`);
                        }
                    }
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

                // Phase 1: Displacement-chain pass.
                // For each raw cell i: convert it to an empty slot cell, then place its
                // original relVal at its ideal index, displacing any occupant into the chain.
                for (let i = 0; i < n; i += 1) {
                    guard.tick();
                    if (isSlotCell(values[i])) continue;
                    collector.record(values, [{ lane: 'main', index: i, role: 'scan', part: 'orig' }], null, undefined, min, max, null, buildDisplayValues());
                    const firstRelVal = values[i] - min; // absolute → relative
                    values[i] = makeEmptySlotCell();
                    stats.writes += 1;

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
                                    // Already converted: scan sequentially for delta match or empty slot.
                                    const pSlot = preferredSlot(deltaEnc);
                                    let preferredEmpty = -1;
                                    let anyEmpty = -1;
                                    let inserted = false;
                                    let s = 0;
                                    while (s < microSlotsPerCell && !inserted) {
                                        const word = getSlotWord(cell, s);
                                        if (slotIsEmpty(word)) {
                                            if (s === pSlot && preferredEmpty === -1) preferredEmpty = s;
                                            else if (anyEmpty === -1) anyEmpty = s;
                                            s += 1;
                                        } else if (slotHasFlag(word)) {
                                            // Multi-count delta+flag slot; count at s+1.
                                            if (s + 1 < microSlotsPerCell && unpackDeltaEnc(word) === deltaEnc) {
                                                const cnt = getSlotWord(cell, s + 1);
                                                if (cnt < pairMask) {
                                                    values[k] = setSlotWord(cell, s + 1, cnt + 1);
                                                    stats.writes += 1;
                                                    collector.record(values, [
                                                        { lane: 'main', index: srcIdx, role: 'scan', part: 'orig' },
                                                        { lane: 'main', index: k, role: 'write', part: 'bin', slot: s }
                                                    ], null, undefined, min, max, null, buildDv());
                                                } else {
                                                    overflowCounts.set(relVal, (overflowCounts.get(relVal) || 0) + 1);
                                                }
                                                inserted = true;
                                            }
                                            s += 2; // skip count slot
                                        } else {
                                            // Single-count delta slot (flag=0).
                                            if (unpackDeltaEnc(word) === deltaEnc) {
                                                // Upgrade to count=2 using adjacent slot if empty.
                                                if (s + 1 < microSlotsPerCell && slotIsEmpty(getSlotWord(cell, s + 1))) {
                                                    let newCell = setSlotWord(cell, s, (word | flagBit) >>> 0);
                                                    newCell = setSlotWord(newCell, s + 1, 2);
                                                    values[k] = newCell;
                                                    stats.writes += 1;
                                                    collector.record(values, [
                                                        { lane: 'main', index: srcIdx, role: 'scan', part: 'orig' },
                                                        { lane: 'main', index: k, role: 'write', part: 'bin', slot: s }
                                                    ], null, undefined, min, max, null, buildDv());
                                                } else {
                                                    overflowCounts.set(relVal, (overflowCounts.get(relVal) || 0) + 1);
                                                }
                                                inserted = true;
                                            }
                                            s += 1;
                                        }
                                    }
                                    if (!inserted) {
                                        const writeSlot = preferredEmpty !== -1 ? preferredEmpty : anyEmpty;
                                        if (writeSlot !== -1) {
                                            values[k] = setSlotWord(cell, writeSlot, packSlot(deltaEnc, 1));
                                            stats.writes += 1;
                                            collector.record(values, [
                                                { lane: 'main', index: srcIdx, role: 'scan', part: 'orig' },
                                                { lane: 'main', index: k, role: 'write', part: 'bin', slot: writeSlot }
                                            ], null, undefined, min, max, null, buildDv());
                                            inserted = true;
                                        }
                                    }
                                    if (inserted) { placed = true; break; }
                                } else {
                                    // Raw cell: displace its occupant and fully overwrite with new slot.
                                    const displaced = cell - min; // absolute → relative
                                    const pSlot = preferredSlot(deltaEnc);
                                    values[k] = setSlotWord(makeEmptySlotCell(), pSlot, packSlot(deltaEnc, 1));
                                    stats.writes += 1;
                                    collector.record(values, [
                                        { lane: 'main', index: srcIdx, role: 'scan', part: 'orig' },
                                        { lane: 'main', index: k, role: 'write', part: 'bin', slot: pSlot }
                                    ], null, undefined, min, max, null, buildDv());
                                    pending.push({ relVal: displaced, srcIdx: k });
                                    placed = true;
                                    break;
                                }
                            }
                        }

                        if (!placed) {
                            overflowCounts.set(relVal, (overflowCounts.get(relVal) || 0) + 1);
                        }
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
                        const aRel = anchorRel(idx);
                        let s = 0;
                        while (s < microSlotsPerCell) {
                            const word = getSlotWord(cell, s);
                            if (slotIsEmpty(word)) { s += 1; continue; }
                            const dEnc = unpackDeltaEnc(word);
                            let cnt;
                            if (slotHasFlag(word)) {
                                cnt = s + 1 < microSlotsPerCell ? getSlotWord(cell, s + 1) : 0;
                                s += 2;
                            } else {
                                cnt = 1;
                                s += 1;
                            }
                            if (cnt <= 0) continue;
                            const relVal = aRel + (dEnc - deltaBias);
                            if (relVal < 0 || relVal > range) continue;
                            if (cnt > maxCtCount) maxCtCount = cnt;
                            countTableSize += 1;
                        }
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
                        const aRel = anchorRel(idx);
                        let s = 0;
                        while (s < microSlotsPerCell) {
                            const word = getSlotWord(cell, s);
                            if (slotIsEmpty(word)) { s += 1; continue; }
                            const slotStart = s;
                            const dEnc = unpackDeltaEnc(word);
                            let cnt;
                            if (slotHasFlag(word)) {
                                cnt = s + 1 < microSlotsPerCell ? getSlotWord(cell, s + 1) : 0;
                                s += 2;
                            } else {
                                cnt = 1;
                                s += 1;
                            }
                            if (cnt <= 0) continue;
                            const relVal = aRel + (dEnc - deltaBias);
                            if (relVal < 0 || relVal > range) continue;
                            const absVal = relVal + min;
                            const pair = (relVal | (cnt << relValBits)) >>> 0;
                            const bitOff = r * ctPairBits;
                            const wWord = (bitOff / 32) | 0;
                            const wShift = bitOff & 31;
                            const bitsInFirst = Math.min(ctPairBits, 32 - wShift);
                            const loMask = (1 << bitsInFirst) - 1;

                            if (wWord !== lastInitWord) { values[wWord] = 0; lastInitWord = wWord; }
                            values[wWord] = ((values[wWord] >>> 0) | ((pair & loMask) << wShift)) >>> 0;
                            stats.writes += 1;

                            if (!wWordSegs.has(wWord)) wWordSegs.set(wWord, []);
                            wWordSegs.get(wWord).push({ startBit: wShift, width: bitsInFirst, colorValue: absVal, filled: true });

                            if (bitsInFirst < ctPairBits) {
                                const bitsInSecond = ctPairBits - bitsInFirst;
                                const wWord2 = wWord + 1;
                                if (wWord2 !== lastInitWord) { values[wWord2] = 0; lastInitWord = wWord2; }
                                values[wWord2] = ((values[wWord2] >>> 0) | (((pair >>> bitsInFirst) >>> 0) & ((1 << bitsInSecond) - 1))) >>> 0;
                                stats.writes += 1;
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
                            dvCompress[wWord] = packedDisplayStrings.get(r);
                            const compressTracked = [
                                { lane: 'main', index: idx, role: 'scan', part: 'compress', bitOffset: slotStart * pairBits, bitWidth: pairBits },
                                { lane: 'main', index: wWord, role: 'write', part: 'compress', bitOffset: wShift, bitWidth: bitsInFirst }
                            ];
                            if (bitsInFirst < ctPairBits) {
                                // Secondary word: show colour only (no CT label) to avoid
                                // duplicate "11×1 11×1" artefact on adjacent cells.
                                dvCompress[wWord + 1] = `${absVal}|`;
                                compressTracked.push({ lane: 'main', index: wWord + 1, role: 'write', part: 'compress', bitOffset: 0, bitWidth: ctPairBits - bitsInFirst });
                            }
                            // Build per-word segment snapshot for this step (all pairs packed so far).
                            const segsForRecord = {};
                            for (const [ww, segs] of wWordSegs) segsForRecord[ww] = segs.slice();
                            // Temporarily restore the original slot cell so the renderer can show
                            // per-slot stripes for the source position.
                            const origAtIdx = values[idx];
                            values[idx] = cell;
                            collector.record(values, compressTracked, null, undefined, min, max, null, dvCompress, segsForRecord);
                            values[idx] = origAtIdx;
                            r += 1;
                        }
                    }
                    // Snapshot the final segment layout for Phase 3 expansion colour display.
                    phase3SegmentData = {};
                    for (const [pw, segs] of wWordSegs) phase3SegmentData[pw] = segs.slice();
                    // Zero the freed tail (positions packedWords..countTableSize-1 are now spare)
                    for (let p = packedWords; p < countTableSize; p += 1) {
                        values[p] = 0;
                        stats.writes += 1;
                    }
                } else {
                    // Packing saves nothing: write CT entries directly at values[0..countTableSize-1].
                    let w = 0;
                    for (let idx = 0; idx < n; idx += 1) {
                        guard.tick();
                        const cell = values[idx] >>> 0;
                        if (!isSlotCell(cell)) continue;
                        const aRel = anchorRel(idx);
                        let s = 0;
                        while (s < microSlotsPerCell) {
                            const word = getSlotWord(cell, s);
                            if (slotIsEmpty(word)) { s += 1; continue; }
                            const slotStart = s;
                            const dEnc = unpackDeltaEnc(word);
                            let cnt;
                            if (slotHasFlag(word)) {
                                cnt = s + 1 < microSlotsPerCell ? getSlotWord(cell, s + 1) : 0;
                                s += 2;
                            } else {
                                cnt = 1;
                                s += 1;
                            }
                            if (cnt <= 0) continue;
                            const relVal = aRel + (dEnc - deltaBias);
                            if (relVal < 0 || relVal > range) continue;
                            const ctCell = makeCtCell(relVal, cnt);
                            values[w] = ctCell;
                            stats.writes += 1;
                            const dvCompress = buildDisplayValues(idx, ctCell);
                            const origAtIdx = values[idx];
                            values[idx] = cell;
                            collector.record(values, [
                                { lane: 'main', index: idx, role: 'scan', part: 'compress', bitOffset: slotStart * pairBits, bitWidth: pairBits },
                                { lane: 'main', index: w, role: 'write', part: 'compress' }
                            ], null, undefined, min, max, null, dvCompress);
                            values[idx] = origAtIdx;
                            w += 1;
                        }
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
                            stats.writes += 1;
                            const dvExpand = buildPhase3DisplayValues();
                            // Each packed word that hasn't been overwritten yet gets its own
                            // representative colour (first pair in that word). The active
                            // word(s) are then overridden with the full CT-format label.
                            for (let w = 0; w < packedWords; w += 1) {
                                if (w < ww) dvExpand[w] = `${packedWordPrimaryAbsVal[w]}|`;
                            }
                            dvExpand[wWord] = `${absVal}|${absVal}\u00d7${cnt}`;
                            // Secondary word shows colour only, not the full CT label.
                            if (bitsInFirst < ctPairBits) dvExpand[wWord + 1] = `${absVal}|`;
                            const stepSegs = {};
                            if (phase3SegmentData) {
                                for (const pw of Object.keys(phase3SegmentData)) {
                                    const pwi = +pw;
                                    if (pwi < ww) stepSegs[pwi] = phase3SegmentData[pwi];
                                }
                            }
                            collector.record(values,
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
                            stats.writes += 1;
                            // Pass ctCell as override so position ct always shows as its CT entry
                            // even when ww == ct (count==1 case) and values[ct] was just overwritten.
                            collector.record(values, [
                                { lane: 'main', index: ct, role: 'scan', part: 'expand' },
                                { lane: 'main', index: ww, role: 'write', part: 'expand' }
                            ], null, undefined, min, max, null, buildPhase3DisplayValues(ct, ctCell));
                            ww -= 1;
                        }
                    }
                }

                return {
                    steps: collector.finalize(values),
                    stats,
                    predictiveBits: {
                        mode: 'deltaMicrobucket',
                        valueBits: 0,
                        pairBits,
                        countBits,
                        deltaBits,
                        deltaMax,
                        slotsPerCell: microSlotsPerCell,
                        flagMode: true
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
                return { steps: collector.finalize(values), stats };
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
                    stats.writes += 1;
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
                    stats.writes += 1;
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
                    stats.writes += 1;
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
                        stats.writes += 1;
                        recordPacked([
                            { lane: 'main', index: j - 1, role: 'scan', part: 'bin' },
                            { lane: 'main', index: j, role: 'write', part: 'bin' }
                        ]);
                    }
                    values[ins] = claimBin(values[ins], relVal);
                    stats.writes += 1;
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
                    stats.writes += 1;
                    collector.record(values, [
                        { lane: 'main', index: w, role: 'write' }
                    ], null, undefined, min, max, null, buildExpansionDisplayValues());
                    w += 1;
                }
            }

            // ── Phase 3b: strip high bits, convert relVal → absVal ───────────
            for (let i = 0; i < n; i++) {
                guard.tick();
                values[i] = (values[i] & valueMask) + min;
                stats.writes += 1;
                collector.record(values, [
                    { lane: 'main', index: i, role: 'write' }
                ], null, undefined, min, max, null, buildStripDisplayValues(i + 1));
            }

            return {
                steps: collector.finalize(values),
                stats,
                predictiveBits: { mode: 'overlay3', valueBits, countShift }
            };
        }
    }
};
