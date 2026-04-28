export const Button = {
  Up: 1 << 0,
  Down: 1 << 1,
  Left: 1 << 2,
  Right: 1 << 3,
} as const;

const KEY_TO_BIT: Record<string, number> = {
  ArrowUp: Button.Up,
  ArrowDown: Button.Down,
  ArrowLeft: Button.Left,
  ArrowRight: Button.Right,
};

export type InputChange = (buttons: number, clientTimeMs: number) => void;

export function installInput(onChange: InputChange): () => void {
  let mask = 0;
  let lastSent = 0;

  const flush = () => {
    if (mask !== lastSent) {
      lastSent = mask;
      onChange(mask, Date.now());
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const bit = KEY_TO_BIT[e.key];
    if (bit === undefined) return;
    mask |= bit;
    e.preventDefault();
    flush();
  };

  const onKeyUp = (e: KeyboardEvent) => {
    const bit = KEY_TO_BIT[e.key];
    if (bit === undefined) return;
    mask &= ~bit;
    e.preventDefault();
    flush();
  };

  const onBlur = () => {
    mask = 0;
    flush();
  };

  const onVisibility = () => {
    if (document.hidden) {
      mask = 0;
      flush();
    }
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
