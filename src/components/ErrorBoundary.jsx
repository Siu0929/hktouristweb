"use client";

import { Component } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * React ErrorBoundary that catches render-time errors in its subtree,
 * displays a friendly inline message, and lets the rest of the app keep
 * working. Usage: wrap any subtree that might throw (e.g. map pages).
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("[ErrorBoundary] caught:", error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      const { error } = this.state;
      return (
        <div
          role="alert"
          aria-live="polite"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            padding: "32px 16px",
            textAlign: "center",
            color: "#6b7280",
          }}
        >
          <AlertTriangle size={32} style={{ color: "#f59e0b" }} />
          <p style={{ fontSize: 14, fontWeight: 600, color: "#374151" }}>
            {this.props.fallbackTitle ?? "Something went wrong"}
          </p>
          {error?.message && (
            <p style={{ fontSize: 12, color: "#9ca3af", maxWidth: 320 }}>
              {error.message}
            </p>
          )}
          <button
            onClick={this.handleReset}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 16px",
              borderRadius: 8,
              border: "1px solid #d1d5db",
              background: "#fff",
              fontSize: 13,
              color: "#374151",
              cursor: "pointer",
            }}
          >
            <RefreshCw size={14} />
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
