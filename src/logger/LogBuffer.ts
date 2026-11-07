/** Longest line kept in the buffer, longer ones are cut */
const MAX_LINE_LENGTH = 1000;

/** How many lines are kept. The oldest lines are dropped first. */
const MAX_LINES = 3000;

// eslint-disable-next-line no-control-regex
const ANSI_COLOR = /\x1b\[[0-9;]*m/g;

/**
 * In-memory copy of everything the Logger prints, so it can be shown and copied from inside the game.
 * Plain text only (no terminal color codes).
 */
export class LogBuffer {
    private static lines: string[] = [];
    private static changeCounter = 0;

    /** Goes up on every push/clear. The log box uses it to know when to redraw. */
    static get version(): number {
        return LogBuffer.changeCounter;
    }

    static get count(): number {
        return LogBuffer.lines.length;
    }

    static push(line: string): void {
        let clean = line.replace(ANSI_COLOR, "");
        if (clean.length > MAX_LINE_LENGTH) {
            clean = clean.slice(0, MAX_LINE_LENGTH) + "...(cut)";
        }

        LogBuffer.lines.push(clean);
        if (LogBuffer.lines.length > MAX_LINES) {
            LogBuffer.lines.shift();
        }
        LogBuffer.changeCounter++;
    }

    static clear(): void {
        LogBuffer.lines = [];
        LogBuffer.changeCounter++;
    }

    /**
     * All lines joined with newlines.
     *
     * @param maxChars Optional limit. When the log is longer, only the newest part is returned (Android clipboard has a size limit).
     */
    static text(maxChars?: number): string {
        const all = LogBuffer.lines.join("\n");
        if (maxChars === undefined || all.length <= maxChars) return all;
        return "(older lines cut)\n" + all.slice(all.length - maxChars);
    }
}
