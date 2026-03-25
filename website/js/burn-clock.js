export function localDateISO(d) {
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
}

export function processHourlyData(allHistograms, localDateStr) {
    const hourlyData = [];
    const localMidnight = new Date(localDateStr + 'T00:00:00');
    const now = new Date();
    const isToday = localDateStr === localDateISO(now);

    for (let h = 0; h < 24; h++) {
        const t = new Date(localMidnight.getTime() + h * 3600000);
        const utcDate = t.toISOString().split('T')[0];
        const utcHour = t.getUTCHours();
        const key = utcDate + ':' + utcHour;

        const raw = allHistograms[key];
        const histogramOrPeak = (typeof raw === 'object' && raw !== null && raw.histogram) ? raw.histogram : raw;
        const sessions = [];

        if (typeof histogramOrPeak === 'object' && histogramOrPeak !== null) {
            for (let n = 1; n <= 7; n++) {
                let totalMins = 0;
                for (const [conc, mins] of Object.entries(histogramOrPeak)) {
                    if (parseInt(conc, 10) >= n) totalMins += mins;
                }
                if (totalMins > 0) {
                    const seed = (h * 7 + n * 13) % 17;
                    const variation = 0.85 + (seed / 17) * 0.15;
                    const intensity = Math.min((totalMins / 60) * variation, 1);
                    sessions.push({ index: n, intensity, minutes: totalMins });
                }
            }
        } else if (typeof histogramOrPeak === 'number' && histogramOrPeak > 0) {
            for (let n = 1; n <= histogramOrPeak; n++) {
                const seed = (h * 7 + n * 13) % 17;
                const intensity = 0.5 + (seed / 17) * 0.5;
                sessions.push({ index: n, intensity, minutes: 30 });
            }
        }

        const isCurrent = isToday && h === now.getHours();
        hourlyData.push({ hour: h, sessions, isCurrent, date: t });
    }
    return hourlyData;
}

function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s || '?';
    return d.innerHTML;
}

function getV5Color(intensity) {
    const r1 = 245, g1 = 170, b1 = 100;
    const r2 = 210, g2 = 70, b2 = 15;
    return `rgb(${Math.round(r1 + (r2 - r1) * intensity)},${Math.round(g1 + (g2 - g1) * intensity)},${Math.round(b1 + (b2 - b1) * intensity)})`;
}

export function renderActivityTimeline(svg, hourlyData, isDark) {
    const cellW = 16, cellH = 16, gap = 2;
    const margin = 8;
    const cardW = margin + 24 * (cellW + gap) - gap + margin;

    let maxSessions = 0;
    for (const data of hourlyData) {
        if (data.sessions.length > maxSessions) maxSessions = data.sessions.length;
    }
    const maxRows = Math.max(1, maxSessions);
    const gridHeight = maxRows * (cellH + gap) - gap;
    const gridTopY = margin;
    const cardH = gridTopY + gridHeight + margin;

    const emptyCell = isDark ? '#232323' : '#e0ddd9';
    const getColor = isDark
        ? (i) => { const r1=245,g1=170,b1=100,r2=210,g2=70,b2=15; return `rgb(${Math.round(r1+(r2-r1)*i)},${Math.round(g1+(g2-g1)*i)},${Math.round(b1+(b2-b1)*i)})`; }
        : getV5Color;

    svg.setAttribute('viewBox', `0 0 ${cardW} ${cardH}`);

    let s = '';

    // Grid cells only
    for (let col = 0; col < 24; col++) {
        const data = hourlyData[col];
        for (let row = 0; row < maxRows; row++) {
            const x = margin + col * (cellW + gap);
            const y = gridTopY + (maxRows - 1 - row) * (cellH + gap);
            s += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="3" ry="3" fill="${emptyCell}" opacity="0.8"/>`;
        }
        for (const session of data.sessions) {
            if (session.index > maxRows) continue;
            const row = session.index - 1;
            const x = margin + col * (cellW + gap);
            const y = gridTopY + (maxRows - 1 - row) * (cellH + gap);
            const color = getColor(session.intensity || 0.5);
            s += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="3" ry="3" fill="${color}"/>`;
        }
    }

    svg.innerHTML = s;
}

export function renderShareableCardV5(svg, hourlyData, sessions, cardData) {
    sessions = sessions || [];
    const cellW = 22, cellH = 22, gap = 3;
    const gridMarginLeft = 60;
    const gridMarginRight = 30;
    const cardW = gridMarginLeft + 24 * (cellW + gap) - gap + gridMarginRight;

    let maxSessions = 0;
    for (const data of hourlyData) {
        if (data.sessions.length > maxSessions) maxSessions = data.sessions.length;
    }
    const maxRows = Math.max(1, maxSessions);
    const gridHeight = maxRows * (cellH + gap) - gap;

    const activeMins = cardData.activeMins || 0;
    const activeH = Math.floor(activeMins / 60);
    const activeM = Math.round(activeMins % 60);

    const dateObj = cardData.localDateStr ? new Date(cardData.localDateStr + 'T12:00:00') : new Date();
    const monthNames = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const dateDisplay = `${monthNames[dateObj.getMonth()]} ${dateObj.getDate()}, ${dateObj.getFullYear()}`;

    const topY = 30, usernameY = 58;
    const divider1Y = 80, gridLabelY = 110, gridTopY = 130;
    const gridBottomY = gridTopY + gridHeight + 24;
    const divider2Y = gridBottomY + 10;
    const statsY = divider2Y + 20;
    const statsHeight = 70;
    const divider3Y = statsY + statsHeight + 10;
    const footerY = divider3Y + 25;
    const cardH = footerY + 20;

    svg.setAttribute('viewBox', `0 0 ${cardW} ${cardH}`);

    let s = '';
    s += `<rect width="${cardW}" height="${cardH}" rx="16" ry="16" fill="#ffffff"/>`;
    const v5HasAvatar = !!cardData.avatarDataUrl;
    const v5TextX = v5HasAvatar ? 80 : 30;
    if (v5HasAvatar) {
        s += `<defs><clipPath id="v5AvatarClip"><circle cx="50" cy="40" r="20"/></clipPath></defs>`;
        s += `<image href="${cardData.avatarDataUrl}" x="30" y="20" width="40" height="40" clip-path="url(#v5AvatarClip)" preserveAspectRatio="xMidYMid slice"/>`;
    }
    s += `<text x="${v5TextX}" y="${topY}" fill="#8a8480" font-size="10" font-family="inherit" font-weight="700" letter-spacing="2">CLAUDERANK</text>`;
    s += `<text x="${v5TextX}" y="${usernameY}" fill="#1a1a1a" font-size="20" font-family="inherit" font-weight="700">@${escHtml(cardData.username || 'anonymous')}</text>`;

    s += `<text class="card-date-text" x="${cardW - 30}" y="${usernameY}" fill="#8a8480" font-size="13" font-family="inherit" font-weight="600" letter-spacing="1.5" text-anchor="end" opacity="0">${dateDisplay}</text>`;

    s += `<line x1="30" y1="${divider1Y}" x2="${cardW - 30}" y2="${divider1Y}" stroke="#c8c0b8" stroke-width="1"/>`;
    s += `<text x="30" y="${gridLabelY}" fill="#8a8480" font-size="11" font-family="inherit" font-weight="700" letter-spacing="1.5">AGENT ACTIVITY TIMELINE</text>`;

    const legendW = 80, legendH = 10;
    const gridRightEdge = gridMarginLeft + 23 * (cellW + gap) + cellW;
    const legendY = gridLabelY - 10;
    s += `<defs><linearGradient id="v5LegendGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="rgb(245,170,100)"/><stop offset="100%" stop-color="rgb(210,70,15)"/></linearGradient></defs>`;
    s += `<text x="${gridRightEdge}" y="${legendY + legendH - 1}" fill="#8a8480" font-size="9" font-family="inherit" font-weight="600" text-anchor="end">HIGH</text>`;
    const highTextW = 28;
    const legendX = gridRightEdge - highTextW - legendW;
    s += `<rect x="${legendX}" y="${legendY}" width="${legendW}" height="${legendH}" rx="3" ry="3" fill="url(#v5LegendGrad)"/>`;
    s += `<text x="${legendX - 6}" y="${legendY + legendH - 1}" fill="#8a8480" font-size="9" font-family="inherit" font-weight="600" text-anchor="end">LOW</text>`;

    for (let row = 0; row < maxRows; row++) {
        const y = gridTopY + (maxRows - 1 - row) * (cellH + gap) + cellH / 2 + 4;
        s += `<text x="30" y="${y}" fill="#8a8480" font-size="10" font-family="inherit" font-weight="600">A${row + 1}</text>`;
    }

    for (let col = 0; col < 24; col++) {
        const data = hourlyData[col];
        for (let row = 0; row < maxRows; row++) {
            const x = gridMarginLeft + col * (cellW + gap);
            const y = gridTopY + (maxRows - 1 - row) * (cellH + gap);
            s += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="3" ry="3" fill="#e0ddd9" opacity="0.8"/>`;
        }
        for (const session of data.sessions) {
            if (session.index > maxRows) continue;
            const row = session.index - 1;
            const x = gridMarginLeft + col * (cellW + gap);
            const y = gridTopY + (maxRows - 1 - row) * (cellH + gap);
            const color = getV5Color(session.intensity || 0.5);
            s += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="3" ry="3" fill="${color}"/>`;
        }
    }

    const xAxisY = gridTopY + gridHeight + 18;
    const fmtHr = (h) => { const hh = ((h % 24) + 24) % 24; return hh === 0 ? '12AM' : hh < 12 ? hh + 'AM' : hh === 12 ? '12PM' : (hh - 12) + 'PM'; };
    s += `<text x="${gridMarginLeft}" y="${xAxisY}" fill="#8a8480" font-size="10" font-family="inherit">${fmtHr(0)}</text>`;
    s += `<text x="${gridMarginLeft + 12 * (cellW + gap)}" y="${xAxisY}" fill="#8a8480" font-size="10" font-family="inherit">${fmtHr(12)}</text>`;
    s += `<text x="${gridMarginLeft + 23 * (cellW + gap)}" y="${xAxisY}" fill="#8a8480" font-size="10" font-family="inherit" text-anchor="end">${fmtHr(23)}</text>`;

    s += `<line x1="30" y1="${divider2Y}" x2="${cardW - 30}" y2="${divider2Y}" stroke="#c8c0b8" stroke-width="1"/>`;

    const estSpend = cardData.estimatedSpend || 0;
    const spendDisplay = estSpend >= 1000 ? '$' + (estSpend / 1000).toFixed(1) + 'K' : '$' + estSpend.toFixed(2);
    const colW = (cardW - 60) / 3;
    const statsLabels = ['CONCURRENT AGENTS', 'CURRENT STREAK', 'EST. SPEND'];
    const hourlyStreakVal = cardData.hourlyStreak != null ? cardData.hourlyStreak : 0;
    const statsValues = [maxSessions + '\u00d7', hourlyStreakVal + 'h', spendDisplay];
    const statsColors = ['#E8692D', '#1a1a1a', '#1a1a1a'];

    for (let i = 0; i < 3; i++) {
        const cx = 30 + colW * i + colW / 2;
        s += `<text x="${cx}" y="${statsY + 18}" fill="#8a8480" font-size="10" font-family="inherit" font-weight="700" letter-spacing="1" text-anchor="middle">${statsLabels[i]}</text>`;
        s += `<text id="v5Stat${i}" x="${cx}" y="${statsY + 50}" fill="${statsColors[i]}" font-size="24" font-family="monospace" font-weight="700" text-anchor="middle">${statsValues[i]}</text>`;
        if (i < 2) {
            const divX = 30 + colW * (i + 1);
            s += `<line x1="${divX}" y1="${statsY + 4}" x2="${divX}" y2="${statsY + statsHeight - 4}" stroke="#c8c0b8" stroke-width="1"/>`;
        }
    }

    s += `<line x1="30" y1="${divider3Y}" x2="${cardW - 30}" y2="${divider3Y}" stroke="#c8c0b8" stroke-width="1"/>`;
    s += `<text x="${cardW / 2}" y="${footerY}" fill="#8a8480" font-size="10" font-family="inherit" font-weight="600" letter-spacing="1.5" text-anchor="middle">CLAUDERANK.COM</text>`;

    svg.innerHTML = s;
}

export function renderShareableCardV6(svg, hourlyData, sessions, cardData) {
    sessions = sessions || [];
    const cellW = 22, cellH = 22, gap = 3;
    const gridMarginLeft = 60;
    const gridMarginRight = 30;
    const cardW = gridMarginLeft + 24 * (cellW + gap) - gap + gridMarginRight;

    let maxSessions = 0;
    for (const data of hourlyData) {
        if (data.sessions.length > maxSessions) maxSessions = data.sessions.length;
    }
    const maxRows = Math.max(1, maxSessions);
    const gridHeight = maxRows * (cellH + gap) - gap;

    function getV6Color(intensity) {
        const r1 = 245, g1 = 170, b1 = 100;
        const r2 = 210, g2 = 70, b2 = 15;
        return `rgb(${Math.round(r1 + (r2 - r1) * intensity)},${Math.round(g1 + (g2 - g1) * intensity)},${Math.round(b1 + (b2 - b1) * intensity)})`;
    }

    const dateObj = cardData.localDateStr ? new Date(cardData.localDateStr + 'T12:00:00') : new Date();
    const monthNames = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const dateDisplay = `${monthNames[dateObj.getMonth()]} ${dateObj.getDate()}, ${dateObj.getFullYear()}`;

    const topY = 30, usernameY = 58;
    const divider1Y = 80, gridLabelY = 110, gridTopY = 130;
    const gridBottomY = gridTopY + gridHeight + 24;
    const divider2Y = gridBottomY + 10;
    const statsY = divider2Y + 20;
    const statsHeight = 70;
    const divider3Y = statsY + statsHeight + 10;
    const footerY = divider3Y + 25;
    const cardH = footerY + 20;

    svg.setAttribute('viewBox', `0 0 ${cardW} ${cardH}`);

    let s = '';
    s += `<rect width="${cardW}" height="${cardH}" rx="16" ry="16" fill="#111111"/>`;
    const v6HasAvatar = !!cardData.avatarDataUrl;
    const v6TextX = v6HasAvatar ? 80 : 30;
    if (v6HasAvatar) {
        s += `<defs><clipPath id="v6AvatarClip"><circle cx="50" cy="40" r="20"/></clipPath></defs>`;
        s += `<image href="${cardData.avatarDataUrl}" x="30" y="20" width="40" height="40" clip-path="url(#v6AvatarClip)" preserveAspectRatio="xMidYMid slice"/>`;
    }
    s += `<text x="${v6TextX}" y="${topY}" fill="#999999" font-size="10" font-family="inherit" font-weight="700" letter-spacing="2">CLAUDERANK</text>`;
    s += `<text x="${v6TextX}" y="${usernameY}" fill="#ececec" font-size="20" font-family="inherit" font-weight="700">@${escHtml(cardData.username || 'anonymous')}</text>`;

    s += `<text class="card-date-text" x="${cardW - 30}" y="${usernameY}" fill="#999999" font-size="13" font-family="inherit" font-weight="600" letter-spacing="1.5" text-anchor="end" opacity="0">${dateDisplay}</text>`;

    s += `<line x1="30" y1="${divider1Y}" x2="${cardW - 30}" y2="${divider1Y}" stroke="#333333" stroke-width="1"/>`;
    s += `<text x="30" y="${gridLabelY}" fill="#999999" font-size="11" font-family="inherit" font-weight="700" letter-spacing="1.5">AGENT ACTIVITY TIMELINE</text>`;

    const legendW = 80, legendH = 10;
    const gridRightEdge = gridMarginLeft + 23 * (cellW + gap) + cellW;
    const legendY = gridLabelY - 10;
    s += `<defs><linearGradient id="v6LegendGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="rgb(245,170,100)"/><stop offset="100%" stop-color="rgb(210,70,15)"/></linearGradient></defs>`;
    s += `<text x="${gridRightEdge}" y="${legendY + legendH - 1}" fill="#999999" font-size="9" font-family="inherit" font-weight="600" text-anchor="end">HIGH</text>`;
    const highTextW = 28;
    const legendX = gridRightEdge - highTextW - legendW;
    s += `<rect x="${legendX}" y="${legendY}" width="${legendW}" height="${legendH}" rx="3" ry="3" fill="url(#v6LegendGrad)"/>`;
    s += `<text x="${legendX - 6}" y="${legendY + legendH - 1}" fill="#999999" font-size="9" font-family="inherit" font-weight="600" text-anchor="end">LOW</text>`;

    for (let row = 0; row < maxRows; row++) {
        const y = gridTopY + (maxRows - 1 - row) * (cellH + gap) + cellH / 2 + 4;
        s += `<text x="30" y="${y}" fill="#999999" font-size="10" font-family="inherit" font-weight="600">A${row + 1}</text>`;
    }

    for (let col = 0; col < 24; col++) {
        const data = hourlyData[col];
        for (let row = 0; row < maxRows; row++) {
            const x = gridMarginLeft + col * (cellW + gap);
            const y = gridTopY + (maxRows - 1 - row) * (cellH + gap);
            s += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="3" ry="3" fill="#232323"/>`;
        }
        for (const session of data.sessions) {
            if (session.index > maxRows) continue;
            const row = session.index - 1;
            const x = gridMarginLeft + col * (cellW + gap);
            const y = gridTopY + (maxRows - 1 - row) * (cellH + gap);
            const color = getV6Color(session.intensity || 0.5);
            s += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="3" ry="3" fill="${color}"/>`;
        }
    }

    const xAxisY = gridTopY + gridHeight + 18;
    const fmtHr = (h) => { const hh = ((h % 24) + 24) % 24; return hh === 0 ? '12AM' : hh < 12 ? hh + 'AM' : hh === 12 ? '12PM' : (hh - 12) + 'PM'; };
    s += `<text x="${gridMarginLeft}" y="${xAxisY}" fill="#999999" font-size="10" font-family="inherit">${fmtHr(0)}</text>`;
    s += `<text x="${gridMarginLeft + 12 * (cellW + gap)}" y="${xAxisY}" fill="#999999" font-size="10" font-family="inherit">${fmtHr(12)}</text>`;
    s += `<text x="${gridMarginLeft + 23 * (cellW + gap)}" y="${xAxisY}" fill="#999999" font-size="10" font-family="inherit" text-anchor="end">${fmtHr(23)}</text>`;

    s += `<line x1="30" y1="${divider2Y}" x2="${cardW - 30}" y2="${divider2Y}" stroke="#333333" stroke-width="1"/>`;

    const estSpend = cardData.estimatedSpend || 0;
    const spendDisplay = estSpend >= 1000 ? '$' + (estSpend / 1000).toFixed(1) + 'K' : '$' + estSpend.toFixed(2);
    const colW = (cardW - 60) / 3;
    const statsLabels = ['CONCURRENT AGENTS', 'CURRENT STREAK', 'EST. SPEND'];
    const hourlyStreakVal = cardData.hourlyStreak != null ? cardData.hourlyStreak : 0;
    const statsValues = [maxSessions + '\u00d7', hourlyStreakVal + 'h', spendDisplay];
    const statsColors = ['#E8692D', '#ececec', '#ececec'];

    for (let i = 0; i < 3; i++) {
        const cx = 30 + colW * i + colW / 2;
        s += `<text x="${cx}" y="${statsY + 18}" fill="#999999" font-size="10" font-family="inherit" font-weight="700" letter-spacing="1" text-anchor="middle">${statsLabels[i]}</text>`;
        s += `<text id="v5Stat${i}" x="${cx}" y="${statsY + 50}" fill="${statsColors[i]}" font-size="24" font-family="monospace" font-weight="700" text-anchor="middle">${statsValues[i]}</text>`;
        if (i < 2) {
            const divX = 30 + colW * (i + 1);
            s += `<line x1="${divX}" y1="${statsY + 4}" x2="${divX}" y2="${statsY + statsHeight - 4}" stroke="#333333" stroke-width="1"/>`;
        }
    }

    s += `<line x1="30" y1="${divider3Y}" x2="${cardW - 30}" y2="${divider3Y}" stroke="#333333" stroke-width="1"/>`;
    s += `<text x="${cardW / 2}" y="${footerY}" fill="#999999" font-size="10" font-family="inherit" font-weight="600" letter-spacing="1.5" text-anchor="middle">CLAUDERANK.COM</text>`;

    svg.innerHTML = s;
}
