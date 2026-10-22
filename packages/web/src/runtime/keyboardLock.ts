import { NAVIGATION_KEYS } from '../view/navigationKeys';

interface BrowserKeyboard {
  lock(keys: string[]): Promise<void>;
  unlock(): void;
}

export interface KeyboardLockState {
  phase: 'idle' | 'requesting' | 'active';
  error: string | null;
}

interface Session {
  phase: 'requesting' | 'active';
  cancelled: boolean;
  enteredFullscreen: boolean;
}

function browserKeyboard(): BrowserKeyboard | undefined {
  return (navigator as Navigator & { keyboard?: BrowserKeyboard }).keyboard;
}

/** One explicit, user-initiated fullscreen/keyboard lifetime. Never locks Escape. */
export class NavigationKeyboardLock {
  private session: Session | null = null;
  private error: string | null = null;
  private disposed = false;
  constructor(
    private readonly onChange: (state: KeyboardLockState) => void,
    private readonly doc: Document = document,
    private readonly keyboard: BrowserKeyboard | undefined = browserKeyboard(),
  ) {}

  get supported(): boolean {
    return !!(
      this.doc.fullscreenEnabled &&
      typeof this.doc.documentElement.requestFullscreen === 'function' &&
      typeof this.keyboard?.lock === 'function' &&
      typeof this.keyboard?.unlock === 'function'
    );
  }

  private emit(): void {
    if (!this.disposed) this.onChange({ phase: this.session?.phase ?? 'idle', error: this.error });
  }

  private readonly fullscreenChanged = () => {
    const session = this.session;
    if (!session || this.doc.fullscreenElement === this.doc.documentElement) return;
    session.cancelled = true;
    this.keyboard!.unlock();
    if (session.phase === 'active') void this.exit();
  };

  async enter(): Promise<void> {
    if (this.disposed || this.session || !this.supported) return;
    const session: Session = {
      phase: 'requesting',
      cancelled: false,
      enteredFullscreen: !this.doc.fullscreenElement,
    };
    this.session = session;
    this.error = null;
    this.doc.addEventListener('fullscreenchange', this.fullscreenChanged);
    this.emit();
    try {
      if (session.enteredFullscreen) await this.doc.documentElement.requestFullscreen();
      if (session.cancelled || this.disposed) return;
      if (this.doc.fullscreenElement !== this.doc.documentElement) throw new Error('viewer fullscreen is unavailable');
      await this.keyboard!.lock([...NAVIGATION_KEYS]);
      if (session.cancelled || this.disposed) return;
      session.phase = 'active';
      this.emit();
    } catch (error) {
      if (!session.cancelled) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (session.phase !== 'active' || session.cancelled || this.disposed) await this.release(session);
    }
  }

  async exit(): Promise<void> {
    const session = this.session;
    if (!session) return;
    session.cancelled = true;
    this.keyboard!.unlock();
    if (session.phase === 'active') {
      session.phase = 'requesting';
      this.emit();
      await this.release(session);
    } else {
      // A permission prompt may still be pending. Retain ownership until enter()
      // settles, so its late completion cannot unlock a replacement session.
      try {
        if (session.enteredFullscreen && this.doc.fullscreenElement === this.doc.documentElement)
          await this.doc.exitFullscreen();
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        this.emit();
      }
    }
  }

  private async release(session: Session): Promise<void> {
    try {
      this.keyboard!.unlock();
      if (session.enteredFullscreen && this.doc.fullscreenElement === this.doc.documentElement)
        await this.doc.exitFullscreen();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.session === session) {
        this.session = null;
        this.doc.removeEventListener('fullscreenchange', this.fullscreenChanged);
        this.emit();
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.doc.removeEventListener('fullscreenchange', this.fullscreenChanged);
    void this.exit();
  }
}
