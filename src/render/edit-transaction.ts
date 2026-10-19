/** A completed preview can be kept; an abandoned preview restores its retained state. */
export class EditTransaction {
  private state?: { keep: () => void; restore: () => void };
  constructor(keep: () => void, restore: () => void) {
    this.state = { keep, restore };
  }
  commit() {
    const state = this.state;
    if (!state) throw new Error('Edit transaction is unavailable.');
    this.state = undefined;
    state.keep();
  }
  rollback() {
    const state = this.state;
    if (!state) return;
    this.state = undefined;
    state.restore();
  }
  dispose() {
    this.rollback();
  }
}
