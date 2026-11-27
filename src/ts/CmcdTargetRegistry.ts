/** Origin of `url`, the report destination of Request Mode. All invalid URLs share the empty origin. */
export function toOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * State per report destination.
 * Only the most recently used destinations are kept, so memory stays bounded.
 */
export class CmcdTargetRegistry<T> {
  private readonly targets = new Map<string, T>();

  constructor(private readonly createTarget: (key: string) => T, private readonly maxTargets: number) {}

  /** State of the destination `key`, marked as most recently used */
  get(key: string): T {
    let target = this.targets.get(key);
    if (target !== undefined) {
      this.targets.delete(key);
    } else {
      target = this.createTarget(key);
      if (this.targets.size >= this.maxTargets) {
        this.targets.delete(this.targets.keys().next().value as string);
      }
    }
    this.targets.set(key, target);
    return target;
  }

  forEach(callback: (target: T) => void): void {
    this.targets.forEach((target) => callback(target));
  }
}
