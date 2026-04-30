function createStepCollector(initialValues, statsRef = null) {
    const steps = [{
        values: [...initialValues],
        trackedIndices: [],
        auxValues: null,
        carryValue: undefined,
        minValue: undefined,
        maxValue: undefined,
        writtenValues: null,
        statsSnapshot: statsRef ? { ...statsRef } : undefined
    }];

    return {
        record(values, trackedIndices = [], auxValues = null, carryValue = undefined, minValue = undefined, maxValue = undefined, writtenValues = null) {
            steps.push({
                values: [...values],
                trackedIndices: trackedIndices.map((entry) => ({ ...entry })),
                auxValues: auxValues ? [...auxValues] : null,
                carryValue,
                minValue,
                maxValue,
                writtenValues: writtenValues ? [...writtenValues] : null,
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
    }
};
