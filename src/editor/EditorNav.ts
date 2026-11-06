import { NavGrid } from "../world/NavGrid";

/** 编辑器预览共用的一份世界数据（只读，没有玩家修改） */
let nav: NavGrid | null = null;
export function editorNav(): NavGrid {
    if (!nav) nav = new NavGrid();
    return nav;
}
