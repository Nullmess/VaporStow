import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

class RendererErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
    state: { error: Error | null } = { error: null };

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error('VaporStow renderer error:', error, info.componentStack);
    }

    render() {
        if (!this.state.error) return this.props.children;

        return (
            <main className="renderer-error">
                <strong>VaporStow UI error</strong>
                <p>The cloud data is untouched. Only the interface failed to render.</p>
                <code>{this.state.error.message || String(this.state.error)}</code>
                <button onClick={() => window.location.reload()}>Reload interface</button>
            </main>
        );
    }
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <RendererErrorBoundary>
            <App />
        </RendererErrorBoundary>
    </StrictMode>
);
