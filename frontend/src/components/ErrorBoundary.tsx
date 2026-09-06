import { Component } from "preact";
import type { ComponentChildren } from "preact";

// Stops one bad render from blanking the whole app until you reload.
//
// Audit finding, from "the application is disconnecting and i have to constantly refresh". There
// was no error boundary anywhere in this app, and Preact, like React, unmounts the ENTIRE tree
// when a render throws and nothing catches it. One undefined field reached with a `!` in one row
// of one table takes the page to blank, the console message scrolls away, and the only recovery
// is F5. That is indistinguishable from "the app disconnected" to anyone not watching devtools.
//
// This does not stop the bug that threw. It stops the bug from costing the whole session, and it
// puts the actual error on screen so the next one is reportable instead of invisible.

interface Props {
  children: ComponentChildren;
  /** Named so the panel can say which part of the app failed rather than just "something". */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error("[ErrorBoundary]", this.props.label ?? "app", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="panel rounded-xl p-5 m-4 max-w-3xl">
        <h2 className="text-sm font-semibold text-rose-300 mb-1">
          {this.props.label ? `The ${this.props.label} panel crashed` : "This page crashed"}
        </h2>
        <p className="text-xs text-gray-400 mb-3 max-w-xl">
          The rest of the app is still running. This is a bug worth reporting, so the error is
          printed below rather than swallowed.
        </p>
        <pre className="text-[11px] font-mono text-rose-300/90 bg-black/40 rounded-lg p-3 overflow-x-auto max-h-52">
          {this.state.error.message}
          {this.state.error.stack ? `\n\n${this.state.error.stack}` : ""}
        </pre>
        <div className="flex gap-2 mt-3">
          <button
            onClick={() => this.setState({ error: null })}
            className="px-3 h-8 rounded-lg text-xs bg-white/10 hover:bg-white/15 text-gray-100"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-3 h-8 rounded-lg text-xs bg-white/5 hover:bg-white/10 text-gray-400"
          >
            Reload the page
          </button>
        </div>
      </div>
    );
  }
}
