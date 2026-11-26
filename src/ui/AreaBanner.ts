import { PlaceInfo, newPlaceInfo, placeAt, placeKeyAt } from "../world/Areas";

/** 进入新区域 / 小地名后要再往里走这么多米才提示，免得在边界上来回走时反复弹字 */
const ENTER_MARGIN = 8;
/** 淡入、停留、淡出的时长（秒） */
const FADE_IN = 0.5, HOLD = 2.2, FADE_OUT = 1.0;
/** 只换了小地名时的提示短一些 */
const PLACE_HOLD = 1.6;

/**
 * 进入区域时屏幕上方的提示：
 * - 换了区域：大字区域名，下面一行小字小地名（"明月湖" / "湖心岛"）；
 * - 同一个区域里换了小地名：只显示一行小字。
 * 开局也会提示。
 */
export class AreaBanner {
    private title = new Laya.Text();
    private sub = new Laya.Text();
    private info = newPlaceInfo();
    private currentArea = -1;
    private currentPlace = -1;
    private areaText = "";
    private placeText = "";
    /** 当前提示已经显示了多久（秒）；负数表示没有在显示 */
    private t = -1;
    private hold = HOLD;

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
        const s = this.sub;
        s.fontSize = 30;
        s.color = "#f2ead0";
        s.stroke = 4;
        s.strokeColor = "#2a1c08";
        s.align = "center";
        s.alpha = 0;
        s.mouseEnabled = false;
        Laya.stage.addChild(s);
        this.layout();
        Laya.stage.on(Laya.Event.RESIZE, this, this.layout);
    }

    /** 当前所在区域和小地名（HUD 用） */
    get area() { return this.placeText ? `${this.areaText} · ${this.placeText}` : this.areaText; }

    private layout() {
        const top = Math.round(Laya.stage.height * 0.16);
        this.title.width = Laya.stage.width;
        this.title.pos(0, top);
        this.sub.width = Laya.stage.width;
        this.sub.pos(0, top + 80);
    }

    /** 整个身位都在同一个小地名格子里才算进入（开局直接算） */
    private inside(wx: number, wz: number, key: number): boolean {
        if (this.currentPlace < 0) return true;
        const m = ENTER_MARGIN;
        return placeKeyAt(wx - m, wz) === key && placeKeyAt(wx + m, wz) === key &&
            placeKeyAt(wx, wz - m) === key && placeKeyAt(wx, wz + m) === key;
    }

    /** 每帧调用 */
    update(dt: number, wx: number, wz: number) {
        const p: PlaceInfo = placeAt(wx, wz, this.info);
        if (p.placeKey !== this.currentPlace) {
            // placeAt 的结果会被 placeKeyAt 覆盖，先记下来
            const areaKey = p.area.key, placeKey = p.placeKey, areaName = p.areaName, placeName = p.placeName;
            if (this.inside(wx, wz, placeKey)) {
                const newArea = areaKey !== this.currentArea;
                this.currentArea = areaKey;
                this.currentPlace = placeKey;
                this.areaText = areaName;
                this.placeText = placeName;
                this.title.text = newArea ? areaName : "";
                this.sub.text = placeName;
                this.hold = newArea ? HOLD : PLACE_HOLD;
                this.t = 0;
            }
        }
        if (this.t < 0) return;
        this.t += dt;
        const t = this.t, hold = this.hold;
        let a: number;
        if (t < FADE_IN) a = t / FADE_IN;
        else if (t < FADE_IN + hold) a = 1;
        else if (t < FADE_IN + hold + FADE_OUT) a = 1 - (t - FADE_IN - hold) / FADE_OUT;
        else { a = 0; this.t = -1; }
        this.title.alpha = a;
        this.sub.alpha = a;
    }

    destroy() {
        Laya.stage.offAllCaller(this);
        this.title.destroy();
        this.sub.destroy();
    }
}
