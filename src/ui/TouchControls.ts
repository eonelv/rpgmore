/** 屏幕右下角操作区的按钮 */
export type TouchButton = "attack" | "chop" | "far" | "peak";

interface Btn { id: TouchButton; label: string; x: number; y: number; r: number; view: Laya.Sprite; text: Laya.Text; held: number | null }

/** 一根手指当前在干什么 */
interface Finger {
    role: "stick" | "cam" | "btn";
    btn?: Btn;
    x: number; y: number;
    downX: number; downY: number; downTime: number;
    /** 离按下的位置超过 TAP_MOVE，不算点击 */
    moved: boolean;
    /** 参与过双指缩放，不算点击 */
    pinched: boolean;
}

/** 手指移动不超过这么多像素、按下不超过 TAP_TIME 毫秒算一次点击（点地面寻路、点树砍树） */
const TAP_MOVE = 15;
const TAP_TIME = 350;
/** 摇杆死区（摇杆半径的比例） */
const DEADZONE = 0.15;

/**
 * 手机上的触屏操作：
 * - 左手边（屏幕左侧 45%）按下出现摇杆，拖动控制移动，力度决定速度；
 * - 其他区域单指拖动旋转镜头（左右转视角、上下调俯仰），双指捏合缩放；
 * - 右下角操作区：攻击（按住连射）、砍树（按住连砍）、去远方、去山顶；
 * - 轻点（没拖动）还是原来的点击：点地面寻路、点树走过去砍、点小地图寻路。
 * 只读输入，不直接操作角色和相机，Main 每帧读取 moveX / moveZ / held() 和回调
 */
export class TouchControls {
    /** 摇杆输入：x 向右、z 向下（朝镜头）为正，长度 0~1 */
    moveX = 0;
    moveZ = 0;
    /** 点击（没拖动）：舞台坐标 */
    onTap: (x: number, y: number) => void = () => { };
    /** 拖动旋转镜头：本次移动的像素（已按屏幕大小归一） */
    onRotate: (dx: number, dy: number) => void = () => { };
    /** 双指缩放：两指距离的比值（> 1 = 张开 = 拉近） */
    onPinch: (ratio: number) => void = () => { };
    /** 按钮按下的一瞬间 */
    onPress: (id: TouchButton) => void = () => { };

    private root = new Laya.Sprite();
    private stickBase = new Laya.Sprite();
    private stickKnob = new Laya.Sprite();
    private fingers = new Map<number, Finger>();
    private stickId: number | null = null;
    private stickX = 0; private stickY = 0;
    private stickR = 60;
    private restX = 0; private restY = 0;
    private buttons: Btn[] = [];
    /** 双指缩放上一帧两指的距离（0 = 没在缩放） */
    private pinchDist = 0;
    /** 屏幕短边，按钮尺寸、旋转灵敏度按它缩放 */
    private S = 750;

    /**
     * blocked：这个位置被别的界面占了（例如排查帧率的按钮），不响应。
     * bottomInset：底部留给别的界面的高度，摇杆和按钮整体往上挪
     */
    constructor(private blocked: (x: number, y: number) => boolean, private bottomInset = 0) {
        this.root.mouseEnabled = false;
        this.root.addChild(this.stickBase);
        this.root.addChild(this.stickKnob);
        const defs: [TouchButton, string][] = [["attack", "攻击"], ["chop", "砍树"], ["peak", "去山顶"], ["far", "去远方"]];
        for (const [id, label] of defs) {
            const view = new Laya.Sprite();
            const text = new Laya.Text();
            text.text = label;
            text.color = "#ffffff";
            text.stroke = 3;
            text.strokeColor = "#000000";
            text.align = "center"; text.valign = "middle";
            view.addChild(text);
            this.root.addChild(view);
            this.buttons.push({ id, label, x: 0, y: 0, r: 0, view, text, held: null });
        }
        Laya.stage.addChild(this.root);
        this.layout();
        Laya.stage.on(Laya.Event.RESIZE, this, this.layout);
        Laya.stage.on(Laya.Event.MOUSE_DOWN, this, this.onDown);
        Laya.stage.on(Laya.Event.MOUSE_MOVE, this, this.onMove);
        Laya.stage.on(Laya.Event.MOUSE_UP, this, this.onUp);
    }

    /** 这个按钮现在是不是按着 */
    held(id: TouchButton): boolean {
        return this.buttons.some(b => b.id === id && b.held !== null);
    }

    destroy() {
        Laya.stage.offAllCaller(this);
        this.root.destroy(true);
    }

    private layout() {
        const W = Laya.stage.width, H = Laya.stage.height - this.bottomInset;
        this.S = Math.min(W, Laya.stage.height);
        // 摇杆：平时停在左下角，手指按下时移到手指的位置
        this.stickR = this.S * 0.12;
        this.restX = this.stickR * 1.6;
        this.restY = H - this.stickR * 1.6;
        this.drawStick();
        this.placeStick(this.restX, this.restY, 0, 0);
        // 右下角操作区：攻击键最大，砍树、去山顶、去远方沿着它左上方排成一圈
        const R = this.S * 0.1, r = R * 0.62;
        const ax = W - R * 1.5, ay = H - R * 1.5;
        const pos: Record<TouchButton, [number, number, number]> = {
            attack: [ax, ay, R],
            chop: [ax - R * 2.1, ay + R * 0.3, r],
            peak: [ax - R * 1.75, ay - R * 1.6, r],
            far: [ax + R * 0.05, ay - R * 2.2, r],
        };
        for (const b of this.buttons) {
            [b.x, b.y, b.r] = pos[b.id];
            b.text.fontSize = Math.round(Math.min(b.r * 0.55, b.r * 1.6 / b.label.length));
            b.text.size(b.r * 2, b.r * 2);
            b.text.pos(b.x - b.r, b.y - b.r);
            this.drawButton(b);
        }
    }

    private drawStick() {
        const g = this.stickBase.graphics;
        g.clear();
        g.drawCircle(0, 0, this.stickR, "#000000", "#ffffff", 3);
        this.stickBase.alpha = 0.3;
        const k = this.stickKnob.graphics;
        k.clear();
        k.drawCircle(0, 0, this.stickR * 0.45, "#ffffff", "#000000", 2);
        this.stickKnob.alpha = 0.55;
    }

    private placeStick(bx: number, by: number, dx: number, dy: number) {
        this.stickBase.pos(bx, by);
        this.stickKnob.pos(bx + dx, by + dy);
    }

    private drawButton(b: Btn) {
        const g = b.view.graphics;
        g.clear();
        const on = b.held !== null;
        const fill = b.id === "attack" ? (on ? "#e05a3a" : "#a8402a") : (on ? "#4a90d0" : "#2c5f8f");
        g.drawCircle(b.x, b.y, b.r, fill, "#ffffff", 3);
        b.view.alpha = on ? 0.85 : 0.55;
    }

    private buttonAt(x: number, y: number): Btn | null {
        for (const b of this.buttons)
            if ((x - b.x) ** 2 + (y - b.y) ** 2 <= (b.r * 1.15) ** 2) return b;
        return null;
    }

    private onDown(e: Laya.Event) {
        const x = e.touchPos.x, y = e.touchPos.y, id = e.touchId;
        if (this.fingers.has(id) || this.blocked(x, y)) return;
        const f: Finger = { role: "cam", x, y, downX: x, downY: y, downTime: performance.now(), moved: false, pinched: false };
        const b = this.buttonAt(x, y);
        if (b) {
            f.role = "btn"; f.btn = b;
            b.held = id;
            this.drawButton(b);
            this.onPress(b.id);
        } else if (x < Laya.stage.width * 0.45 && this.stickId === null) {
            f.role = "stick";
            this.stickId = id;
            this.stickX = x; this.stickY = y;
            this.placeStick(x, y, 0, 0);
            this.stickBase.alpha = 0.45;
        }
        this.fingers.set(id, f);
        this.startPinchIfTwo();
    }

    private onMove(e: Laya.Event) {
        const f = this.fingers.get(e.touchId);
        if (!f) return;
        const x = e.touchPos.x, y = e.touchPos.y;
        if (!f.moved && Math.hypot(x - f.downX, y - f.downY) > TAP_MOVE) f.moved = true;
        if (f.role === "stick") {
            let dx = x - this.stickX, dy = y - this.stickY;
            const len = Math.hypot(dx, dy);
            if (len > this.stickR) { dx *= this.stickR / len; dy *= this.stickR / len; }
            this.placeStick(this.stickX, this.stickY, dx, dy);
            const m = Math.min(1, len / this.stickR);
            if (m < DEADZONE) { this.moveX = this.moveZ = 0; }
            else {
                // 死区外从 0 开始线性增大，轻推慢走，推到底全速
                const k = (m - DEADZONE) / (1 - DEADZONE) / (len || 1);
                this.moveX = (x - this.stickX) * k;
                this.moveZ = (y - this.stickY) * k;
            }
        } else if (f.role === "cam") {
            const cams = this.camFingers();
            if (cams.length >= 2 && this.pinchDist > 0) {
                // 先更新这根手指的位置，再算两指距离
                f.x = x; f.y = y;
                const d = Math.hypot(cams[0].x - cams[1].x, cams[0].y - cams[1].y);
                if (d > 1) { this.onPinch(d / this.pinchDist); this.pinchDist = d; }
                return;
            }
            if (f.moved) this.onRotate((x - f.x) / this.S, (y - f.y) / this.S);
        }
        f.x = x; f.y = y;
    }

    private onUp(e: Laya.Event) {
        const id = e.touchId;
        const f = this.fingers.get(id);
        if (!f) return;
        this.fingers.delete(id);
        if (f.role === "stick") {
            this.stickId = null;
            this.moveX = this.moveZ = 0;
            this.placeStick(this.restX, this.restY, 0, 0);
            this.stickBase.alpha = 0.3;
        } else if (f.role === "btn" && f.btn) {
            f.btn.held = null;
            this.drawButton(f.btn);
        } else if (f.role === "cam") {
            // 还剩两根以上手指：按剩下的两根重新算缩放基准，不跳变
            if (this.camFingers().length < 2) this.pinchDist = 0;
            else this.startPinchIfTwo();
            if (!f.moved && !f.pinched && performance.now() - f.downTime < TAP_TIME) this.onTap(f.downX, f.downY);
        }
    }

    private camFingers(): Finger[] {
        const out: Finger[] = [];
        for (const f of this.fingers.values()) if (f.role === "cam") out.push(f);
        return out;
    }

    /** 屏幕上（摇杆、按钮以外）有两根手指：开始双指缩放，这两根手指松开时不算点击 */
    private startPinchIfTwo() {
        const cams = this.camFingers();
        if (cams.length < 2) return;
        for (const c of cams) c.pinched = true;
        this.pinchDist = Math.max(1, Math.hypot(cams[0].x - cams[1].x, cams[0].y - cams[1].y));
    }
}
