import { performance, monitorEventLoopDelay } from "node:perf_hooks";

/** The last `size` values, for percentiles. Averages hide the slow tick that users feel. */
export class Rolling {
    private buf: number[] = [];
    constructor(private size = 100) {}

    push(v: number) {
        this.buf.push(v);
        if (this.buf.length > this.size) this.buf.shift();
    }

    get max() { return this.buf.length ? Math.max(...this.buf) : 0; }
    get p50() { return this.percentile(50); }
    get p99() { return this.percentile(99); }

    private percentile(p: number) {
        if (!this.buf.length) return 0;
        const sorted = [...this.buf].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))]!;
    }
}

export const metrics = {
    /** One whole tick: publish our pixels, send clients theirs. Budget is 50ms at 20Hz. */
    tickMs: new Rolling(200),       // 10 seconds of ticks
    /**
     * The part of the tick spent sending frames to this process's clients. The profile says
     * nearly all of it is the per-socket write, so this is where the ceiling shows first.
     */
    fanoutMs: new Rolling(200),
    // Counters, reset every second so they read as per-second rates.
    /** Should be 20. Below that the ticks are taking longer than their slot. */
    ticks: 0,
    /** Frames heard on the pub/sub bus, from every process. */
    busFramesIn: 0,
    /** Ticks that had something to send. Well below `ticks` means the bus is arriving in clumps. */
    sendingTicks: 0,
    pixelsIn: 0,
    framesOut: 0,
    bytesOut: 0,
};

// Event loop utilisation: the fraction of time the process was busy rather than waiting.
// Near 100% is overloaded no matter which function is to blame, which is why it is here
// alongside the tick and fanout timings that say where the time went.
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
let eluMark = performance.eventLoopUtilization();
let cpuMark = process.cpuUsage();

let last = { ticks: 0, busFramesIn: 0, sendingTicks: 0, pixelsIn: 0, framesOut: 0, bytesOut: 0, busy: 0, cpu: 0, loopDelayP99Ms: 0 };

setInterval(() => {
    const now = performance.eventLoopUtilization();
    const cpu = process.cpuUsage(cpuMark);
    cpuMark = process.cpuUsage();
    last = {
        ticks: metrics.ticks,
        busFramesIn: metrics.busFramesIn,
        sendingTicks: metrics.sendingTicks,
        pixelsIn: metrics.pixelsIn,
        framesOut: metrics.framesOut,
        bytesOut: metrics.bytesOut,
        busy: performance.eventLoopUtilization(now, eluMark).utilization,
        // CPU time actually used, as a fraction of one core. Well below `busy` means the
        // process wanted to run but the machine had no core free for it.
        cpu: (cpu.user + cpu.system) / 1e6,
        // How late a 10ms timer fires. The user-visible symptom of a busy loop.
        loopDelayP99Ms: loopDelay.percentile(99) / 1e6,
    };
    eluMark = now;
    loopDelay.reset();
    metrics.ticks = metrics.busFramesIn = metrics.sendingTicks = metrics.pixelsIn = metrics.framesOut = metrics.bytesOut = 0;
}, 1000).unref();   // unref: never the reason a process (or a test run) stays alive

/** Everything as plain numbers, for GET /metrics. */
export function snapshot() {
    return {
        tickMsP50: metrics.tickMs.p50,
        tickMsP99: metrics.tickMs.p99,
        tickMsMax: metrics.tickMs.max,
        fanoutMsP99: metrics.fanoutMs.p99,
        fanoutMsMax: metrics.fanoutMs.max,
        ...last,
    };
}
