/**
 * State per report destination (origin of the request URL).
 * Only the most recently used origins are kept, so memory stays bounded.
 */
export class CmcdTargetRegistry<T> {
  private readonly targets = new Map<string, T>();

  constructor(private readonly createTarget: () => T, private readonly maxTargets: number) {}

  /** State of the origin of `url`, marked as most recently used. All invalid URLs share one state. */
  get(url: string): T {
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch {
      // Shared by all invalid URLs
    }
    let target = this.targets.get(origin);
    if (target !== undefined) {
      this.targets.delete(origin);
    } else {
      target = this.createTarget();
      if (this.targets.size >= this.maxTargets) {
        this.targets.delete(this.targets.keys().next().value as string);
      }
    }
    this.targets.set(origin, target);
    return target;
  }

  forEach(callback: (target: T) => void): void {
    this.targets.forEach((target) => callback(target));
  }
}
