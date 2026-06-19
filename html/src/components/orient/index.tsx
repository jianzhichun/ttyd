import { bind } from 'decko';
import { h, Component } from 'preact';

// Foldables unfolded / tablets have a short side >= this and read fine in
// portrait, so they are excluded from the landscape nudge.
const SHORT_SIDE_MAX = 600;

function isNarrowPhone(): boolean {
    if (typeof matchMedia === 'undefined') return false;
    const coarse = matchMedia('(pointer: coarse)').matches;
    const shortSide = Math.min(screen.width, screen.height);
    return coarse && shortSide < SHORT_SIDE_MAX;
}

function isPortrait(): boolean {
    if (typeof matchMedia !== 'undefined') return matchMedia('(orientation: portrait)').matches;
    return window.innerHeight >= window.innerWidth;
}

// iOS Safari exposes screen.orientation but not .lock — only Android can be
// programmatically rotated (and only from fullscreen + a user gesture).
function canLock(): boolean {
    const so = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    return !!(so && typeof so.lock === 'function');
}

interface State {
    portrait: boolean;
    dismissed: boolean;
}

export class OrientationHint extends Component<unknown, State> {
    state: State = { portrait: isPortrait(), dismissed: false };

    componentDidMount() {
        if (!isNarrowPhone()) return;
        window.addEventListener('resize', this.update);
        window.addEventListener('orientationchange', this.update);
    }

    componentWillUnmount() {
        window.removeEventListener('resize', this.update);
        window.removeEventListener('orientationchange', this.update);
    }

    @bind
    private update() {
        this.setState({ portrait: isPortrait() });
    }

    @bind
    private async lock() {
        try {
            const el = document.documentElement as HTMLElement & {
                requestFullscreen?: (o?: FullscreenOptions) => Promise<void>;
            };
            const so = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
            if (!document.fullscreenElement && el.requestFullscreen) {
                await el.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
            }
            await so.lock?.('landscape');
        } catch {
            // unsupported / rejected — the rotate hint stays as the fallback
        }
    }

    @bind
    private dismiss() {
        this.setState({ dismissed: true });
    }

    render(_: unknown, { portrait, dismissed }: State) {
        if (!isNarrowPhone() || !portrait || dismissed) return null;
        return (
            <div id="orient-hint">
                <div class="orient-card">
                    <div class="orient-icon">⟳</div>
                    <div class="orient-text">横屏体验更佳</div>
                    <div class="orient-sub">把手机横过来,终端列宽更舒服</div>
                    {canLock() && (
                        <button type="button" class="orient-btn" onClick={this.lock}>
                            切到横屏
                        </button>
                    )}
                    <button type="button" class="orient-link" onClick={this.dismiss}>
                        继续竖屏使用
                    </button>
                </div>
            </div>
        );
    }
}
