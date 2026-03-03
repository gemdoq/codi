import type { Key } from 'readline';

export interface KeyBinding {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  handler: () => void | Promise<void>;
  description: string;
}

export class KeyBindingManager {
  private bindings: Map<string, KeyBinding> = new Map();

  register(binding: KeyBinding): void {
    const id = this.makeId(binding);
    this.bindings.set(id, binding);
  }

  private makeId(binding: Pick<KeyBinding, 'key' | 'ctrl' | 'meta' | 'shift'>): string {
    const parts: string[] = [];
    if (binding.ctrl) parts.push('ctrl');
    if (binding.meta) parts.push('meta');
    if (binding.shift) parts.push('shift');
    parts.push(binding.key);
    return parts.join('+');
  }

  async handle(str: string, key: Key): Promise<boolean> {
    const id = this.makeId({
      key: key.name ?? str,
      ctrl: key.ctrl,
      meta: key.meta,
      shift: key.shift,
    });

    const binding = this.bindings.get(id);
    if (binding) {
      await binding.handler();
      return true;
    }
    return false;
  }

  listBindings(): KeyBinding[] {
    return [...this.bindings.values()];
  }
}
