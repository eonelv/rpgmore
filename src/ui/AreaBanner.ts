import { areaAt } from "../world/Areas";

/** 进入新区域后要再往里走这么多米才提示，免得在边界上来回走时反复弹字 */
const ENTER_MARGIN = 8;
/** 淡入、停留、淡出的时长（秒） */
const FADE_IN = 0.5, HOLD = 2.2, FADE_OUT = 1.0;

/**
 * 进入区域时屏幕上方的大字提示（"明月湖"）。
 * 每次走进一个和当前不同名字的区域都会提示，包括开局。
 */
export class AreaBanner {
    private title = new Laya.Text();
    private current = "";
    /** 当前提示已经显示了多久（秒）；负数表示没有在显示 */
    private t = -1;

    constructor() {
        const t = this.title;
        t.fontSize = 64;
        t.bold = true;
        t.color = "#fff6d8";
        t.stroke = 6;
        t.strokeColor = "#2a1c08";
        t.align = "center";
        t.alpha = 0;
        t.mouseEnabled = false;
        Laya.stage.addChild(t);
        this.layout();
        Laya.stage.on(Laya.Event.RESIZE, this, this.layout);
    }

    /** 当前所在区域的名字 */
    get area() { return this.current; }

    private layout() {
        this.title.width = Laya.stage.width;
        this.title.pos(0, Math.round(Laya.stage.height * 0.16));
    }

    /** 每帧调用 */
    update(dt: number, wx: number, wz: number) {
        const name = areaAt(wx, wz);
        if (name !== this.current) {
            // 开局直接提示；之后要整个身位都进了新区域才算
            const m = ENTER_MARGIN;
            const inside = this.current === "" ||
                (areaAt(wx - m, wz) === name && areaAt(wx + m, wz) === name &&
                    areaAt(wx, wz - m) === name && areaAt(wx, wz + m) === name);
            if (inside) {
                this.current = name;
                this.title.text = name;
                this.t = 0;
            }
        }
        if (this.t < 0) return;
        this.t += dt;
        const t = this.t;
        if (t < FADE_IN) this.title.alpha = t / FADE_IN;
        else if (t < FADE_IN + HOLD) this.title.alpha = 1;
        else if (t < FADE_IN + HOLD + FADE_OUT) this.title.alpha = 1 - (t - FADE_IN - HOLD) / FADE_OUT;
        else { this.title.alpha = 0; this.t = -1; }
    }

    destroy() {
        Laya.stage.offAllCaller(this);
        this.title.destroy();
    }
}
