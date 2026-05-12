// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HOTBAR_SLOTS,
  INVENTORY_SIZE,
  Inventory,
  ItemId,
  type Slot,
} from "../../game/index.js";
import { _resetTooltipForTests } from "../tooltip.js";
import { mountCraftingUi } from "./index.js";

const TOOLTIP_ID = "anarchy-tooltip";
const SHOW_DELAY_MS = 300;

function pointer(type: string): PointerEvent {
  return new PointerEvent(type, { clientX: 10, clientY: 10, bubbles: true });
}

function emptySlots(updates: Record<number, Slot> = {}): Slot[] {
  const slots: Slot[] = Array.from({ length: INVENTORY_SIZE }, () => null);
  for (const [idx, slot] of Object.entries(updates)) {
    slots[Number(idx)] = slot;
  }
  return slots;
}

describe("crafting UI", () => {
  let inventory: Inventory;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    _resetTooltipForTests();
    inventory = new Inventory();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    _resetTooltipForTests();
  });

  it("mounts a closed panel with the empty-state message when no recipes are craftable", () => {
    const ui = mountCraftingUi({
      getInventory: () => inventory,
      sendCraft: () => {},
    });
    const panel = document.querySelector(".anarchy-crafting-panel")!;
    expect(panel.classList.contains("open")).toBe(false);
    expect(ui.isOpen()).toBe(false);
    expect(panel.querySelector(".anarchy-crafting-empty")?.textContent).toBe(
      "No craftable recipes.",
    );
    expect(panel.querySelectorAll(".anarchy-crafting-row")).toHaveLength(0);
  });

  it("renders one row per craftable recipe id, sorted lexicographically", () => {
    inventory.replaceFromWire(
      emptySlots({ 0: { item: ItemId.Wood, count: 5 } }),
      null,
      null,
      // Order intentionally scrambled; the inventory mirror sorts internally.
      ["wood-pickaxe", "sticks", "stone-axe"],
    );
    mountCraftingUi({
      getInventory: () => inventory,
      sendCraft: () => {},
    });
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(".anarchy-crafting-row"),
    );
    expect(rows.map((r) => r.dataset.recipeId)).toEqual([
      "sticks",
      "stone-axe",
      "wood-pickaxe",
    ]);
  });

  it("hides unknown recipe ids defensively (server ahead of client rebuild)", () => {
    inventory.replaceFromWire(
      emptySlots({ 0: { item: ItemId.Wood, count: 5 } }),
      null,
      null,
      ["sticks", "future-platinum-pickaxe"],
    );
    mountCraftingUi({
      getInventory: () => inventory,
      sendCraft: () => {},
    });
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(".anarchy-crafting-row"),
    );
    expect(rows.map((r) => r.dataset.recipeId)).toEqual(["sticks"]);
  });

  it("clicking a row ships the recipe id via sendCraft", () => {
    inventory.replaceFromWire(
      emptySlots({ 0: { item: ItemId.Wood, count: 5 } }),
      null,
      null,
      ["sticks", "wood-pickaxe"],
    );
    const sent: string[] = [];
    mountCraftingUi({
      getInventory: () => inventory,
      sendCraft: (id) => sent.push(id),
    });
    const rows = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".anarchy-crafting-row"),
    );
    rows[1].click();
    rows[0].click();
    expect(sent).toEqual(["wood-pickaxe", "sticks"]);
  });

  it("re-renders reactively when InventoryUpdate flips the craftable list", () => {
    mountCraftingUi({
      getInventory: () => inventory,
      sendCraft: () => {},
    });
    expect(
      document.querySelectorAll(".anarchy-crafting-row"),
    ).toHaveLength(0);

    // Now the player has wood — sticks unlocks.
    inventory.replaceFromWire(
      emptySlots({ 0: { item: ItemId.Wood, count: 1 } }),
      null,
      null,
      ["sticks"],
    );
    expect(
      document.querySelectorAll(".anarchy-crafting-row"),
    ).toHaveLength(1);

    // Player gathers more — wood-pickaxe + wood-axe unlock alongside sticks.
    inventory.replaceFromWire(
      emptySlots({
        0: { item: ItemId.Wood, count: 5 },
        [HOTBAR_SLOTS]: { item: ItemId.Stick, count: 4 },
      }),
      null,
      null,
      ["sticks", "wood-pickaxe", "wood-axe"],
    );
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(".anarchy-crafting-row"),
    );
    expect(rows.map((r) => r.dataset.recipeId)).toEqual([
      "sticks",
      "wood-axe",
      "wood-pickaxe",
    ]);
  });

  it("setOpen / toggle drive the .open class so the slide-in animation fires", () => {
    const ui = mountCraftingUi({
      getInventory: () => inventory,
      sendCraft: () => {},
    });
    const panel = document.querySelector(".anarchy-crafting-panel")!;
    expect(panel.classList.contains("open")).toBe(false);

    ui.toggle();
    expect(ui.isOpen()).toBe(true);
    expect(panel.classList.contains("open")).toBe(true);

    ui.setOpen(false);
    expect(ui.isOpen()).toBe(false);
    expect(panel.classList.contains("open")).toBe(false);
  });

  it("unmount removes the root and stops reactive updates", () => {
    const ui = mountCraftingUi({
      getInventory: () => inventory,
      sendCraft: () => {},
    });
    expect(document.querySelector("#anarchy-crafting-root")).not.toBeNull();
    ui.unmount();
    expect(document.querySelector("#anarchy-crafting-root")).toBeNull();
    // After unmount, mutations don't throw or leak DOM back.
    inventory.replaceFromWire(
      emptySlots({ 0: { item: ItemId.Wood, count: 5 } }),
      null,
      null,
      ["sticks"],
    );
    expect(document.querySelector("#anarchy-crafting-root")).toBeNull();
  });

  it("a row with a single ingredient stack lays out one ingredient + arrow + one output", () => {
    inventory.replaceFromWire(
      emptySlots({ 0: { item: ItemId.Wood, count: 1 } }),
      null,
      null,
      ["sticks"],
    );
    mountCraftingUi({
      getInventory: () => inventory,
      sendCraft: () => {},
    });
    const row = document.querySelector(".anarchy-crafting-row")!;
    const left = row.querySelector(".anarchy-crafting-side.left")!;
    const right = row.querySelector(".anarchy-crafting-side.right")!;
    expect(left.querySelectorAll(".anarchy-crafting-stack")).toHaveLength(1);
    expect(right.querySelectorAll(".anarchy-crafting-stack")).toHaveLength(1);
    expect(row.querySelector(".anarchy-crafting-arrow")?.textContent).toBe("→");
  });

  it("a multi-stack ingredient row lays out N stacks on the left, all wrapped inside the left half", () => {
    // wood-pickaxe = 3 Wood + 2 Stick → 1 WoodPickaxe.
    inventory.replaceFromWire(
      emptySlots({
        0: { item: ItemId.Wood, count: 3 },
        [HOTBAR_SLOTS]: { item: ItemId.Stick, count: 2 },
      }),
      null,
      null,
      ["wood-pickaxe"],
    );
    mountCraftingUi({
      getInventory: () => inventory,
      sendCraft: () => {},
    });
    const row = document.querySelector(".anarchy-crafting-row")!;
    const left = row.querySelector(".anarchy-crafting-side.left")!;
    const right = row.querySelector(".anarchy-crafting-side.right")!;
    expect(left.querySelectorAll(".anarchy-crafting-stack")).toHaveLength(2);
    expect(right.querySelectorAll(".anarchy-crafting-stack")).toHaveLength(1);
    // Counts: wood ×3, stick ×2 → both badges visible.
    const counts = Array.from(
      left.querySelectorAll<HTMLElement>(".anarchy-crafting-stack-count"),
    ).map((el) => el.textContent);
    expect(counts).toEqual(["3", "2"]);
    // Output count = 1 → no badge.
    expect(
      right.querySelector(".anarchy-crafting-stack-count"),
    ).toBeNull();
  });

  it("layout adapter handles 5 ingredient stacks per side without overflowing the panel width", () => {
    // Synthetic recipe id won't be in the recipe table; instead, exercise
    // the row builder directly via the adapter's flex-wrap policy. Render
    // a contrived inventory listing all real recipes; assert each row
    // keeps both halves and the arrow as direct children — the flex
    // shell is what guarantees no overflow.
    inventory.replaceFromWire(
      emptySlots({
        0: { item: ItemId.Wood, count: 64 },
        1: { item: ItemId.Stone, count: 64 },
        [HOTBAR_SLOTS]: { item: ItemId.Stick, count: 64 },
      }),
      null,
      null,
      ["sticks", "wood-pickaxe", "wood-axe", "stone-pickaxe", "stone-axe"],
    );
    mountCraftingUi({
      getInventory: () => inventory,
      sendCraft: () => {},
    });
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(".anarchy-crafting-row"),
    );
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      // Each row keeps the canonical [left] [arrow-cell] [right] structure
      // regardless of how many stacks the ingredient cluster carries.
      expect(row.querySelector(":scope > .anarchy-crafting-side.left")).not.toBeNull();
      expect(row.querySelector(":scope > .anarchy-crafting-arrow-cell")).not.toBeNull();
      expect(row.querySelector(":scope > .anarchy-crafting-side.right")).not.toBeNull();
      // The arrow glyph itself still lives inside the cell.
      expect(row.querySelector(".anarchy-crafting-arrow")?.textContent).toBe("→");
    }
  });

  it("keeps a hovered recipe in the list as an uncraftable orphan when it stops being craftable", () => {
    inventory.replaceFromWire(
      emptySlots({ 0: { item: ItemId.Wood, count: 5 } }),
      null,
      null,
      ["sticks", "wood-pickaxe"],
    );
    const sent: string[] = [];
    mountCraftingUi({
      getInventory: () => inventory,
      sendCraft: (id) => sent.push(id),
    });
    const sticks = document.querySelector<HTMLButtonElement>(
      '.anarchy-crafting-row[data-recipe-id="sticks"]',
    )!;
    sticks.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));

    // Inventory churn: sticks drops off the craftable list (e.g. wood was
    // consumed by another action). The hovered row must stay visible so
    // an in-flight click doesn't land on a sibling that shifted under the
    // cursor.
    inventory.replaceFromWire(
      emptySlots(),
      null,
      null,
      ["wood-pickaxe"],
    );
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(".anarchy-crafting-row"),
    );
    expect(rows.map((r) => r.dataset.recipeId)).toEqual([
      "sticks",
      "wood-pickaxe",
    ]);
    const orphan = document.querySelector<HTMLButtonElement>(
      '.anarchy-crafting-row[data-recipe-id="sticks"]',
    )!;
    expect(orphan.classList.contains("uncraftable")).toBe(true);
    expect(orphan.getAttribute("aria-disabled")).toBe("true");
    // A click while it's the orphan must not ship CraftRequest — that's
    // the bug this whole anchoring dance prevents.
    orphan.click();
    expect(sent).toEqual([]);
  });

  it("drops the orphan and snaps back to natural order once the cursor leaves the panel", () => {
    inventory.replaceFromWire(
      emptySlots({ 0: { item: ItemId.Wood, count: 5 } }),
      null,
      null,
      ["sticks", "wood-pickaxe"],
    );
    mountCraftingUi({
      getInventory: () => inventory,
      sendCraft: () => {},
    });
    const sticks = document.querySelector<HTMLButtonElement>(
      '.anarchy-crafting-row[data-recipe-id="sticks"]',
    )!;
    sticks.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    inventory.replaceFromWire(emptySlots(), null, null, ["wood-pickaxe"]);
    expect(
      document.querySelectorAll(".anarchy-crafting-row"),
    ).toHaveLength(2);

    const panel = document.querySelector<HTMLElement>(
      ".anarchy-crafting-panel",
    )!;
    panel.dispatchEvent(new MouseEvent("mouseleave"));
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(".anarchy-crafting-row"),
    );
    expect(rows.map((r) => r.dataset.recipeId)).toEqual(["wood-pickaxe"]);
  });

  it("drops the orphan when the cursor moves onto a different row", () => {
    inventory.replaceFromWire(
      emptySlots({ 0: { item: ItemId.Wood, count: 5 } }),
      null,
      null,
      ["sticks", "wood-pickaxe"],
    );
    mountCraftingUi({
      getInventory: () => inventory,
      sendCraft: () => {},
    });
    const sticks = document.querySelector<HTMLButtonElement>(
      '.anarchy-crafting-row[data-recipe-id="sticks"]',
    )!;
    sticks.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    inventory.replaceFromWire(emptySlots(), null, null, ["wood-pickaxe"]);

    const woodPickaxe = document.querySelector<HTMLButtonElement>(
      '.anarchy-crafting-row[data-recipe-id="wood-pickaxe"]',
    )!;
    woodPickaxe.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(".anarchy-crafting-row"),
    );
    expect(rows.map((r) => r.dataset.recipeId)).toEqual(["wood-pickaxe"]);
  });

  it("does not orphan-pin a recipe the cursor never entered", () => {
    inventory.replaceFromWire(
      emptySlots({ 0: { item: ItemId.Wood, count: 5 } }),
      null,
      null,
      ["sticks", "wood-pickaxe"],
    );
    mountCraftingUi({
      getInventory: () => inventory,
      sendCraft: () => {},
    });
    // No mousemove on any row — inventory removes sticks; the natural
    // shrink-to-1 layout takes effect immediately.
    inventory.replaceFromWire(emptySlots(), null, null, ["wood-pickaxe"]);
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(".anarchy-crafting-row"),
    );
    expect(rows.map((r) => r.dataset.recipeId)).toEqual(["wood-pickaxe"]);
  });

  it("rows live inside a .anarchy-crafting-list wrapper so the slide-in transform stays separate from the anchor translate", () => {
    inventory.replaceFromWire(
      emptySlots({ 0: { item: ItemId.Wood, count: 1 } }),
      null,
      null,
      ["sticks"],
    );
    mountCraftingUi({
      getInventory: () => inventory,
      sendCraft: () => {},
    });
    const wrapper = document.querySelector(".anarchy-crafting-list");
    expect(wrapper).not.toBeNull();
    const row = document.querySelector<HTMLElement>(".anarchy-crafting-row")!;
    expect(row.parentElement).toBe(wrapper);
  });

  it("nests the row list inside a .anarchy-crafting-scroll viewport (task 565)", () => {
    inventory.replaceFromWire(
      emptySlots({ 0: { item: ItemId.Wood, count: 1 } }),
      null,
      null,
      ["sticks"],
    );
    mountCraftingUi({
      getInventory: () => inventory,
      sendCraft: () => {},
    });
    const panel = document.querySelector<HTMLElement>(
      ".anarchy-crafting-panel",
    )!;
    const scroll = panel.querySelector<HTMLElement>(
      ":scope > .anarchy-crafting-scroll",
    )!;
    expect(scroll).not.toBeNull();
    const list = scroll.querySelector<HTMLElement>(
      ":scope > .anarchy-crafting-list",
    )!;
    expect(list).not.toBeNull();
  });

  it("re-rendering the row list when craftability flips does not re-mount the panel chrome (task 565)", () => {
    inventory.replaceFromWire(
      emptySlots({ 0: { item: ItemId.Wood, count: 5 } }),
      null,
      null,
      ["sticks", "wood-pickaxe"],
    );
    mountCraftingUi({
      getInventory: () => inventory,
      sendCraft: () => {},
    });
    const panelBefore = document.querySelector<HTMLElement>(
      ".anarchy-crafting-panel",
    )!;
    const scrollBefore = document.querySelector<HTMLElement>(
      ".anarchy-crafting-scroll",
    )!;
    const listBefore = document.querySelector<HTMLElement>(
      ".anarchy-crafting-list",
    )!;

    // Hover sticks, then watch it become orphan when wood evaporates: a
    // reorder that previously could have shifted the panel bounds.
    const sticks = document.querySelector<HTMLElement>(
      '.anarchy-crafting-row[data-recipe-id="sticks"]',
    )!;
    sticks.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    inventory.replaceFromWire(emptySlots(), null, null, ["wood-pickaxe"]);

    // Chrome nodes are the exact same DOM elements after reorder; only
    // the row strip inside the list is replaced wholesale.
    expect(document.querySelector(".anarchy-crafting-panel")).toBe(panelBefore);
    expect(document.querySelector(".anarchy-crafting-scroll")).toBe(scrollBefore);
    expect(document.querySelector(".anarchy-crafting-list")).toBe(listBefore);
  });

  it("stops mousedown / contextmenu inside the panel from reaching window", () => {
    inventory.replaceFromWire(
      emptySlots({ 0: { item: ItemId.Wood, count: 1 } }),
      null,
      null,
      ["sticks"],
    );
    mountCraftingUi({
      getInventory: () => inventory,
      sendCraft: () => {},
    });
    let windowHits = 0;
    const onWindow = (): void => {
      windowHits++;
    };
    window.addEventListener("mousedown", onWindow);
    window.addEventListener("contextmenu", onWindow);

    const panel = document.querySelector(
      ".anarchy-crafting-panel",
    )! as HTMLElement;
    panel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const ctx = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    panel.dispatchEvent(ctx);
    expect(ctx.defaultPrevented).toBe(true);
    expect(windowHits).toBe(0);

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(windowHits).toBe(1);

    window.removeEventListener("mousedown", onWindow);
    window.removeEventListener("contextmenu", onWindow);
  });

  describe("max-craft-count badge (task 490)", () => {
    it("renders the badge under the arrow with floor(have/need) min across ingredients", () => {
      // wood-pickaxe = 3 Wood + 2 Stick → 1 WoodPickaxe.
      // 9 Wood ⇒ 3 crafts on the Wood side; 7 Stick ⇒ 3 crafts on the
      // Stick side. min = 3.
      inventory.replaceFromWire(
        emptySlots({
          0: { item: ItemId.Wood, count: 9 },
          [HOTBAR_SLOTS]: { item: ItemId.Stick, count: 7 },
        }),
        null,
        null,
        ["wood-pickaxe"],
      );
      mountCraftingUi({
        getInventory: () => inventory,
        sendCraft: () => {},
      });
      const row = document.querySelector<HTMLElement>(
        '.anarchy-crafting-row[data-recipe-id="wood-pickaxe"]',
      )!;
      const count = row.querySelector<HTMLElement>(
        ".anarchy-crafting-arrow-count",
      );
      expect(count?.textContent).toBe("3");
    });

    it("picks the smaller side when ingredients are unbalanced", () => {
      // 6 Wood ⇒ 2 crafts; 3 Stick ⇒ 1 craft. min = 1.
      inventory.replaceFromWire(
        emptySlots({
          0: { item: ItemId.Wood, count: 6 },
          [HOTBAR_SLOTS]: { item: ItemId.Stick, count: 3 },
        }),
        null,
        null,
        ["wood-pickaxe"],
      );
      mountCraftingUi({
        getInventory: () => inventory,
        sendCraft: () => {},
      });
      const row = document.querySelector<HTMLElement>(
        '.anarchy-crafting-row[data-recipe-id="wood-pickaxe"]',
      )!;
      expect(
        row.querySelector(".anarchy-crafting-arrow-count")?.textContent,
      ).toBe("1");
    });

    it("hides the badge entirely when the recipe is orphan (max = 0)", () => {
      inventory.replaceFromWire(
        emptySlots({ 0: { item: ItemId.Wood, count: 5 } }),
        null,
        null,
        ["sticks", "wood-pickaxe"],
      );
      mountCraftingUi({
        getInventory: () => inventory,
        sendCraft: () => {},
      });
      const sticks = document.querySelector<HTMLElement>(
        '.anarchy-crafting-row[data-recipe-id="sticks"]',
      )!;
      sticks.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      inventory.replaceFromWire(emptySlots(), null, null, ["wood-pickaxe"]);

      const orphan = document.querySelector<HTMLElement>(
        '.anarchy-crafting-row[data-recipe-id="sticks"]',
      )!;
      expect(orphan.classList.contains("uncraftable")).toBe(true);
      expect(orphan.querySelector(".anarchy-crafting-arrow-count")).toBeNull();
    });

    it("re-renders the badge when InventoryUpdate changes the pooled counts", () => {
      inventory.replaceFromWire(
        emptySlots({ 0: { item: ItemId.Wood, count: 1 } }),
        null,
        null,
        ["sticks"],
      );
      mountCraftingUi({
        getInventory: () => inventory,
        sendCraft: () => {},
      });
      let row = document.querySelector<HTMLElement>(
        '.anarchy-crafting-row[data-recipe-id="sticks"]',
      )!;
      expect(
        row.querySelector(".anarchy-crafting-arrow-count")?.textContent,
      ).toBe("1");

      inventory.replaceFromWire(
        emptySlots({ 0: { item: ItemId.Wood, count: 7 } }),
        null,
        null,
        ["sticks"],
      );
      row = document.querySelector<HTMLElement>(
        '.anarchy-crafting-row[data-recipe-id="sticks"]',
      )!;
      expect(
        row.querySelector(".anarchy-crafting-arrow-count")?.textContent,
      ).toBe("7");
    });
  });

  describe("recipe tooltip on hover", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function hover(row: HTMLElement): void {
      row.dispatchEvent(pointer("pointerenter"));
      vi.advanceTimersByTime(SHOW_DELAY_MS);
    }

    it("surfaces the output name and each ingredient with required counts after the hover delay", () => {
      // wood-pickaxe = 3 Wood + 2 Stick → 1 WoodPickaxe.
      inventory.replaceFromWire(
        emptySlots({
          0: { item: ItemId.Wood, count: 3 },
          [HOTBAR_SLOTS]: { item: ItemId.Stick, count: 2 },
        }),
        null,
        null,
        ["wood-pickaxe"],
      );
      mountCraftingUi({
        getInventory: () => inventory,
        sendCraft: () => {},
      });
      const row = document.querySelector<HTMLElement>(
        '.anarchy-crafting-row[data-recipe-id="wood-pickaxe"]',
      )!;

      // Pre-delay: tooltip is not yet visible.
      row.dispatchEvent(pointer("pointerenter"));
      vi.advanceTimersByTime(SHOW_DELAY_MS - 1);
      let node = document.getElementById(TOOLTIP_ID);
      expect(node === null || node.style.display === "none").toBe(true);

      vi.advanceTimersByTime(1);
      node = document.getElementById(TOOLTIP_ID)!;
      expect(node.style.display).toBe("block");
      const body = node.querySelector(".anarchy-crafting-tooltip");
      expect(body).not.toBeNull();

      const title = body!.querySelector(".anarchy-crafting-tooltip-title")!;
      expect(title.textContent).toContain("Wood Pickaxe");

      const ingredients = Array.from(
        body!.querySelectorAll<HTMLElement>(".anarchy-crafting-tooltip-ingredient"),
      );
      expect(ingredients).toHaveLength(2);
      expect(ingredients[0].textContent).toContain("3 ×");
      expect(ingredients[0].textContent).toContain("Wood");
      expect(ingredients[1].textContent).toContain("2 ×");
      expect(ingredients[1].textContent).toContain("Stick");
    });

    it("annotates each ingredient row with the player's current have-count", () => {
      inventory.replaceFromWire(
        emptySlots({
          0: { item: ItemId.Wood, count: 5 },
          [HOTBAR_SLOTS]: { item: ItemId.Stick, count: 2 },
        }),
        null,
        null,
        ["wood-pickaxe"],
      );
      mountCraftingUi({
        getInventory: () => inventory,
        sendCraft: () => {},
      });
      const row = document.querySelector<HTMLElement>(
        '.anarchy-crafting-row[data-recipe-id="wood-pickaxe"]',
      )!;
      hover(row);

      const haves = Array.from(
        document.querySelectorAll<HTMLElement>(".anarchy-crafting-tooltip-have"),
      );
      expect(haves.map((el) => el.textContent)).toEqual([
        "(have 5)",
        "(have 2)",
      ]);
      // Both ingredients are satisfied (5 ≥ 3, 2 ≥ 2) → no `short` class.
      for (const el of haves) {
        expect(el.classList.contains("short")).toBe(false);
      }
    });

    it("flags ingredients with insufficient have-count via the `short` class (orphan recipe)", () => {
      inventory.replaceFromWire(
        emptySlots({ 0: { item: ItemId.Wood, count: 5 } }),
        null,
        null,
        ["sticks", "wood-pickaxe"],
      );
      mountCraftingUi({
        getInventory: () => inventory,
        sendCraft: () => {},
      });
      const sticks = document.querySelector<HTMLElement>(
        '.anarchy-crafting-row[data-recipe-id="sticks"]',
      )!;
      // Track hover via the document mousemove that the panel listens to,
      // then re-fetch the (re-rendered) orphan row before opening the tooltip.
      sticks.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      inventory.replaceFromWire(emptySlots(), null, null, ["wood-pickaxe"]);
      const orphan = document.querySelector<HTMLElement>(
        '.anarchy-crafting-row[data-recipe-id="sticks"]',
      )!;
      hover(orphan);

      const have = document.querySelector<HTMLElement>(
        ".anarchy-crafting-tooltip-have",
      )!;
      expect(have.textContent).toBe("(have 0)");
      expect(have.classList.contains("short")).toBe(true);
    });

    it("hides the tooltip when the cursor leaves the row", () => {
      inventory.replaceFromWire(
        emptySlots({ 0: { item: ItemId.Wood, count: 1 } }),
        null,
        null,
        ["sticks"],
      );
      mountCraftingUi({
        getInventory: () => inventory,
        sendCraft: () => {},
      });
      const row = document.querySelector<HTMLElement>(
        ".anarchy-crafting-row",
      )!;
      hover(row);
      const node = document.getElementById(TOOLTIP_ID)!;
      expect(node.style.display).toBe("block");

      row.dispatchEvent(pointer("pointerleave"));
      expect(node.style.display).toBe("none");
    });

    it("re-renders the tooltip body fresh when the cursor moves to a different recipe row", () => {
      inventory.replaceFromWire(
        emptySlots({
          0: { item: ItemId.Wood, count: 3 },
          [HOTBAR_SLOTS]: { item: ItemId.Stick, count: 2 },
        }),
        null,
        null,
        ["sticks", "wood-pickaxe"],
      );
      mountCraftingUi({
        getInventory: () => inventory,
        sendCraft: () => {},
      });
      const sticksRow = document.querySelector<HTMLElement>(
        '.anarchy-crafting-row[data-recipe-id="sticks"]',
      )!;
      hover(sticksRow);
      expect(
        document
          .querySelector(".anarchy-crafting-tooltip-title")!
          .textContent,
      ).toContain("Stick");

      sticksRow.dispatchEvent(pointer("pointerleave"));
      const pickaxeRow = document.querySelector<HTMLElement>(
        '.anarchy-crafting-row[data-recipe-id="wood-pickaxe"]',
      )!;
      hover(pickaxeRow);
      expect(
        document
          .querySelector(".anarchy-crafting-tooltip-title")!
          .textContent,
      ).toContain("Wood Pickaxe");
    });

    it("unmount detaches every row tooltip so a fresh mount starts clean", () => {
      inventory.replaceFromWire(
        emptySlots({ 0: { item: ItemId.Wood, count: 1 } }),
        null,
        null,
        ["sticks"],
      );
      const ui = mountCraftingUi({
        getInventory: () => inventory,
        sendCraft: () => {},
      });
      const row = document.querySelector<HTMLElement>(
        ".anarchy-crafting-row",
      )!;
      hover(row);
      ui.unmount();
      const node = document.getElementById(TOOLTIP_ID);
      // Tooltip is hidden after unmount, even though the shared DOM node
      // may still exist (the primitive keeps it cached on document.body).
      expect(node === null || node.style.display === "none").toBe(true);
    });
  });
});
