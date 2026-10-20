import React from "react";

export class AppBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div role="alert" className="notice">
        <p>
          The interface could not restore its view. Your session remains in the
          local host.
        </p>
        <button onClick={() => location.reload()}>Reload interface</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
