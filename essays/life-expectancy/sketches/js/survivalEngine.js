/* =========================================================================
   Survival Curve Engine — interactive for the Life Expectancy essay
   ---------------------------------------------------------------------
   Displays all historical Australian birth cohorts (1900 to 2020 at 10-year
   intervals) truncated at their last observed age in the present day (2026),
   alongside the 2026 Period Survival Curve constructed from the present-day
   tips of these cohorts.

   Usage (see example1.js / survival-curve-example1.html):
     const engine = new SurvivalCurveEngine(config);
     await engine.load();
     engine.attachP5(p5GlobalFns);
     // in draw(): engine.draw();
     // in windowResized(): engine.resize(width, height);
   ========================================================================= */

(function (global) {
    'use strict';

    const DEFAULT_CONFIG = {
        dataUrl: 'data/au_life_table.json',
        presentYear: 2026,
        cohortYears: [1900, 1910, 1920, 1930, 1940, 1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020],
        colors: {
            syntheticOutline: '#f59e0b',
            syntheticGlow: 'rgba(245, 158, 11, 0.35)',
            gridLine: 'rgba(0, 0, 0, 0.08)',
            gridLineDark: 'rgba(255, 255, 255, 0.08)',
            axisText: 'rgba(0, 0, 0, 0.65)',
            axisTextDark: 'rgba(255, 255, 255, 0.7)',
            tooltipBg: 'rgba(255, 255, 255, 0.96)',
            tooltipBgDark: 'rgba(30, 30, 30, 0.96)',
        },
        axisFontSize: 11,
    };

    // Color palette for cohort curves (1900 -> 2020)
    const COHORT_HUES = [260, 245, 230, 215, 200, 180, 160, 140, 90, 45, 25, 10, 350];

    function getCohortColor(index, alpha = 1.0) {
        const hue = COHORT_HUES[index % COHORT_HUES.length];
        return `hsla(${hue}, 65%, 45%, ${alpha})`;
    }

    // Find index in cohortYears matching or nearest to a birth year
    function getCohortIndexForBirthYear(cohortYears, birthYear) {
        let bestIdx = 0;
        let minDiff = Infinity;
        for (let i = 0; i < cohortYears.length; i++) {
            const diff = Math.abs(cohortYears[i] - birthYear);
            if (diff < minDiff) {
                minDiff = diff;
                bestIdx = i;
            }
        }
        return bestIdx;
    }

    class SurvivalCurveEngine {
        constructor(config) {
            this.config = Object.assign({}, DEFAULT_CONFIG, config || {}, {
                colors: Object.assign({}, DEFAULT_CONFIG.colors, (config && config.colors) || {}),
            });
            this.data = null;
            this.hoverAge = null;
            this.hoverCohortIdx = null;
            this.canvasW = 0;
            this.canvasH = 0;
            this.ready = false;
        }

        async load() {
            const res = await fetch(this.config.dataUrl);
            this.data = await res.json();
            this.ready = true;
        }

        attachP5(p) {
            this.p = p;
        }

        resize(w, h) {
            this.canvasW = w;
            this.canvasH = h;
        }

        // --- Calculations ---

        _getSingleQx(year, age) {
            const { singleYears, singleQx } = this.data;
            const clampedYear = Math.max(singleYears[0], Math.min(singleYears[singleYears.length - 1], year));
            const clampedAge = Math.max(0, Math.min(100, age));
            const yIdx = clampedYear - singleYears[0];
            return singleQx[yIdx][clampedAge];
        }

        getPeriodCurve(year) {
            const S = [1.0];
            for (let a = 0; a < 100; a++) {
                const q = this._getSingleQx(year, a);
                S.push(S[S.length - 1] * (1 - q));
            }
            return S;
        }

        // Cohort curve truncated at presentYear (2026)
        getTruncatedCohortCurve(birthYear) {
            const presentYear = this.config.presentYear;
            const maxAge = Math.min(100, presentYear - birthYear);
            const S = [1.0];
            for (let a = 0; a < maxAge; a++) {
                const calYear = birthYear + a;
                const q = this._getSingleQx(calYear, a);
                S.push(S[S.length - 1] * (1 - q));
            }
            return { S, birthYear, maxAge };
        }

        getLifeExpectancy(S) {
            let e0 = 0;
            for (let a = 0; a < S.length - 1; a++) {
                e0 += (S[a] + S[a + 1]) / 2;
            }
            return e0;
        }

        // --- Layout bounds ---

        _getLayout() {
            const isMobile = this.canvasW < 500;
            const padL = isMobile ? 38 : 48;
            const padR = isMobile ? 18 : 28;
            const padT = isMobile ? 52 : 58;
            const padB = isMobile ? 42 : 46;

            return {
                left: padL,
                top: padT,
                right: this.canvasW - padR,
                bottom: this.canvasH - padB,
                width: this.canvasW - padL - padR,
                height: this.canvasH - padT - padB,
            };
        }

        // Flipped X coordinates:
        // X axis = Survival fraction S (100% at left, 0% at right)
        // Y axis = Age (0 at bottom, 100 at top)
        _survToX(s, layout) {
            return layout.left + (1 - s) * layout.width;
        }

        _ageToY(age, layout) {
            return layout.bottom - (age / 100) * layout.height;
        }

        _yToAge(y, layout) {
            const clampedY = Math.max(layout.top, Math.min(layout.bottom, y));
            return Math.round(((layout.bottom - clampedY) / layout.height) * 100);
        }

        // --- Interaction ---

        handlePressStart(x, y) {
            this.handleHover(x, y);
            return false;
        }

        handlePressMove(x, y) {
            this.handleHover(x, y);
            return false;
        }

        handlePressEnd() {
            // Keep hover active
        }

        handleHover(x, y) {
            const layout = this._getLayout();
            if (x >= layout.left && x <= layout.right && y >= layout.top && y <= layout.bottom) {
                this.hoverAge = this._yToAge(y, layout);

                // Find nearest cohort curve at this x/y
                const birthYears = this.config.cohortYears;
                let minDistance = Infinity;
                let bestCohortIdx = null;

                for (let i = 0; i < birthYears.length; i++) {
                    const cohort = this.getTruncatedCohortCurve(birthYears[i]);
                    if (this.hoverAge <= cohort.maxAge) {
                        const px = this._survToX(cohort.S[this.hoverAge], layout);
                        const dist = Math.abs(x - px);
                        if (dist < minDistance) {
                            minDistance = dist;
                            bestCohortIdx = i;
                        }
                    }
                }
                this.hoverCohortIdx = minDistance < 35 ? bestCohortIdx : null;
            } else {
                this.hoverAge = null;
                this.hoverCohortIdx = null;
            }
        }

        handleHoverEnd() {
            this.hoverAge = null;
            this.hoverCohortIdx = null;
        }

        // --- Drawing ---

        draw() {
            const p = this.p;
            if (!this.ready || !p) return;

            const layout = this._getLayout();
            const colors = this.config.colors;
            const presentYear = this.config.presentYear;

            p.push();
            p.background(p.color(this.config.bgColor || '#f0f0f0'));

            const S_period2026 = this.getPeriodCurve(presentYear);
            const e0_period2026 = this.getLifeExpectancy(S_period2026);

            this._drawHeader(layout, e0_period2026);
            this._drawGridAndAxes(layout);

            // Draw all Cohort curves
            const cohortYears = this.config.cohortYears;
            const cohortData = cohortYears.map(by => this.getTruncatedCohortCurve(by));

            for (let i = 0; i < cohortYears.length; i++) {
                const c = cohortData[i];
                const isHovered = this.hoverCohortIdx === i;
                const col = getCohortColor(i, isHovered ? 1.0 : (this.hoverCohortIdx !== null ? 0.25 : 0.75));
                const strokeW = isHovered ? 3.0 : 1.8;

                this._drawCohortCurve(c.S, c.maxAge, layout, col, strokeW);
                this._drawCohortLabel(c, i, layout, isHovered);
            }

            // Draw Synthetic Period 2026 Curve made of multi-colored cohort segments + yellow outline
            this._drawSyntheticPeriodCurve(S_period2026, layout);

            if (this.hoverAge !== null) {
                this._drawInspector(layout, S_period2026, cohortData);
            }

            p.pop();
        }

        _drawHeader(layout, e0_period) {
            const p = this.p;
            const isMobile = this.canvasW < 500;
            const dark = this.config.dark;
            const colors = this.config.colors;

            p.push();
            p.noStroke();

            p.fill(dark ? colors.axisTextDark : colors.axisText);
            p.textSize(isMobile ? 12 : 14);
            p.textStyle(p.BOLD);
            p.textAlign(p.LEFT, p.TOP);
            p.text('Observed Cohort Curves & Synthetic 2026 Period Curve', layout.left, 8);

            p.textSize(isMobile ? 10 : 11);
            p.textStyle(p.NORMAL);

            p.fill(colors.syntheticOutline);
            p.text(`━ 2026 Synthetic Period Curve (e₀ = ${e0_period.toFixed(1)} yrs)`, layout.left, isMobile ? 26 : 28);

            p.fill(dark ? colors.axisTextDark : colors.axisText);
            p.text(`━ Truncated Cohort Curves (1900–2020)`, layout.left + (isMobile ? 190 : 250), isMobile ? 26 : 28);

            p.pop();
        }

        _drawGridAndAxes(layout) {
            const p = this.p;
            const dark = this.config.dark;
            const colors = this.config.colors;
            const axisText = dark ? colors.axisTextDark : colors.axisText;
            const gridLine = dark ? colors.gridLineDark : colors.gridLine;

            p.push();
            p.stroke(gridLine);
            p.strokeWeight(1);

            // Horizontal grid lines for Age (0, 20, 40, 60, 80, 100)
            for (let age = 0; age <= 100; age += 20) {
                const y = this._ageToY(age, layout);
                p.line(layout.left, y, layout.right, y);

                p.noStroke();
                p.fill(axisText);
                p.textSize(this.config.axisFontSize);
                p.textAlign(p.RIGHT, p.CENTER);
                p.text(age, layout.left - 6, y);
                p.stroke(gridLine);
            }

            // Vertical grid lines for Survival % (0% to 100%)
            for (let surv = 0; surv <= 1.0; surv += 0.2) {
                const x = this._survToX(surv, layout);
                p.line(x, layout.top, x, layout.bottom);

                p.noStroke();
                p.fill(axisText);
                p.textSize(this.config.axisFontSize);
                p.textAlign(p.CENTER, p.TOP);
                p.text(`${Math.round(surv * 100)}%`, x, layout.bottom + 6);
                p.stroke(gridLine);
            }

            // Y-axis label: Age
            p.noStroke();
            p.fill(axisText);
            p.textSize(this.config.axisFontSize);
            p.textAlign(p.RIGHT, p.BOTTOM);
            p.text('Age', layout.left - 6, layout.top - 6);

            // X-axis label: % Surviving
            p.textAlign(p.CENTER, p.TOP);
            p.text('% Surviving', layout.left + layout.width / 2, layout.bottom + 22);

            p.pop();
        }

        _drawCohortCurve(S, maxAge, layout, strokeColor, strokeW) {
            const p = this.p;
            const limitAge = Math.min(S.length - 1, maxAge);
            p.push();
            p.noFill();
            p.stroke(strokeColor);
            p.strokeWeight(strokeW);

            p.beginShape();
            for (let a = 0; a <= limitAge; a++) {
                p.vertex(this._survToX(S[a], layout), this._ageToY(a, layout));
            }
            p.endShape();

            p.pop();
        }

        _drawCohortLabel(c, idx, layout, isHovered) {
            const p = this.p;
            const tipAge = c.maxAge;
            const tipSurv = c.S[tipAge];
            const x = this._survToX(tipSurv, layout);
            const y = this._ageToY(tipAge, layout);

            p.push();
            p.noStroke();
            p.fill(getCohortColor(idx, isHovered ? 1.0 : 0.8));
            p.textSize(isHovered ? 11 : 9);
            p.textStyle(isHovered ? p.BOLD : p.NORMAL);
            p.textAlign(p.LEFT, p.CENTER);
            p.text(c.birthYear, x + 6, y);
            p.pop();
        }

        // Draws the synthetic period curve constructed from 2026 age-specific rates.
        // Each segment from age a -> a+1 is colored according to the cohort born
        // in 2026 - a, starting at the endpoint of the previous segment.
        // Outlined in thin yellow across the entire curve.
        _drawSyntheticPeriodCurve(S_period, layout) {
            const p = this.p;
            const colors = this.config.colors;
            const presentYear = this.config.presentYear;
            const cohortYears = this.config.cohortYears;

            p.push();

            // 1. Draw subtle yellow glow/outline under the synthetic curve
            p.noFill();
            p.stroke(colors.syntheticGlow);
            p.strokeWeight(3.5);
            p.beginShape();
            for (let a = 0; a <= 100; a++) {
                p.vertex(this._survToX(S_period[a], layout), this._ageToY(a, layout));
            }
            p.endShape();

            p.stroke(colors.syntheticOutline);
            p.strokeWeight(1.5);
            p.beginShape();
            for (let a = 0; a <= 100; a++) {
                p.vertex(this._survToX(S_period[a], layout), this._ageToY(a, layout));
            }
            p.endShape();

            // 2. Draw segments in the color of the cohort borrowed from at that age (2026 - a)
            p.strokeWeight(2.2);
            for (let a = 0; a < 100; a++) {
                const birthYear = presentYear - a;
                const cohortIdx = getCohortIndexForBirthYear(cohortYears, birthYear);
                const col = getCohortColor(cohortIdx);

                const x1 = this._survToX(S_period[a], layout);
                const y1 = this._ageToY(a, layout);
                const x2 = this._survToX(S_period[a + 1], layout);
                const y2 = this._ageToY(a + 1, layout);

                p.stroke(col);
                p.line(x1, y1, x2, y2);
            }

            p.pop();
        }

        _drawInspector(layout, S_period2026, cohortData) {
            const p = this.p;
            const age = this.hoverAge;
            const y = this._ageToY(age, layout);
            const dark = this.config.dark;
            const colors = this.config.colors;

            const pVal = S_period2026[age];
            const pX = this._survToX(pVal, layout);

            // Find cohort born in (2026 - age)
            const matchingBirthYear = 2026 - age;
            const matchingCohortIdx = getCohortIndexForBirthYear(this.config.cohortYears, matchingBirthYear);

            p.push();
            // Horizontal crosshair line for Age
            p.stroke(dark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.3)');
            p.strokeWeight(1);
            if (p.drawingContext.setLineDash) p.drawingContext.setLineDash([3, 3]);
            p.line(layout.left, y, layout.right, y);
            if (p.drawingContext.setLineDash) p.drawingContext.setLineDash([]);

            // Highlight point on Synthetic Period Curve
            p.noStroke();
            p.fill(colors.syntheticOutline);
            p.circle(pX, y, 9);
            p.fill(getCohortColor(matchingCohortIdx));
            p.circle(pX, y, 6);

            // Inspector card setup
            const isTop = age > 60;
            const cardW = 180;
            const cardH = 62;
            const cardX = layout.left + 12;
            const cardY = isTop ? layout.bottom - cardH - 10 : layout.top + 10;

            p.fill(dark ? colors.tooltipBgDark : colors.tooltipBg);
            p.stroke(dark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)');
            p.strokeWeight(1);
            p.rect(cardX, cardY, cardW, cardH, 4);

            p.noStroke();
            p.fill(dark ? colors.axisTextDark : colors.axisText);
            p.textSize(11);
            p.textStyle(p.BOLD);
            p.textAlign(p.LEFT, p.TOP);
            p.text(`Age ${age}`, cardX + 8, cardY + 6);

            p.textSize(10);
            p.textStyle(p.NORMAL);
            p.fill(dark ? colors.axisTextDark : colors.axisText);
            p.text(`2026 Synthetic Survival: ${(pVal * 100).toFixed(1)}%`, cardX + 8, cardY + 22);

            p.fill(getCohortColor(matchingCohortIdx));
            p.text(`Rate borrowed from ~${matchingBirthYear} Cohort`, cardX + 8, cardY + 38);

            p.pop();
        }
    }

    global.SurvivalCurveEngine = SurvivalCurveEngine;
})(window);
