function predictionSort(arr) {
    if (arr.length <= 1) return arr;

    const END_INDEX = arr.length - 1;


    // Initial pass to shift min and max to first and last indices
    if (arr[END_INDEX] < arr[0]) {
        [arr[0], arr[END_INDEX]] = [arr[END_INDEX], arr[0]];
    }

    let i = 1;
    while (i < END_INDEX) {
        if (arr[i] < arr[0]) {
            [arr[0], arr[i]] = [arr[i], arr[0]];
        }
        if (arr[i] > arr[END_INDEX]) {
            [arr[END_INDEX], arr[i]] = [arr[i], arr[END_INDEX]];
            continue;
        }
        i += 1;
    }

    const min = arr[0];
    const max = arr[END_INDEX];
    const interiorStart = 1;
    const interiorEnd = END_INDEX - 1;
    const step = arr.length > 1 ? (max - min) / (END_INDEX) : 0;

    const marked = new Array(arr.length).fill(false);
    marked[0] = true;
    marked[END_INDEX] = true;
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

    let firstUnmarked = interiorStart;

    const nearestUnmarked = (fromIndex) => {
        const start = Math.max(interiorStart, Math.min(interiorEnd + 1, fromIndex + 1));

        for (let i = start; i <= interiorEnd; i++) {
            if (!marked[i]) {
                return i;
            }
        }

        for (let i = interiorStart; i < start; i++) {
            if (!marked[i]) {
                return i;
            }
        }

        return interiorEnd + 1;
    };

    const advanceFirstUnmarked = (currentIndex) => {
        if (markedCount >= arr.length) {
            return interiorEnd + 1;
        }
        return nearestUnmarked(currentIndex);
    };

    // Main algorithm loop
    while (markedCount < arr.length) {

        let check = predictIndex(arr[firstUnmarked]);

        // duplicate check
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

        // Insertion

        // finding initial insertion point

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
            if (firstUnmarked == check) {
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

        // when we have reached the unmarked index
        if (check < interiorStart) {
            check = interiorStart;
        } else if (check > interiorEnd) {
            check = interiorEnd;
        }

        swap(firstUnmarked, check);
        setMarked(check);
        if (firstUnmarked == check) {
            firstUnmarked = advanceFirstUnmarked(firstUnmarked);
        }

    }

    return arr;
}