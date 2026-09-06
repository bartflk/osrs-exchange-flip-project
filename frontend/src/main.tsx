import { render } from "preact";
import "./index.css";
import App from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary";

// A render that throws unmounts the whole tree, so without this the app goes blank and the only
// way back is a manual refresh. Audit finding from "the application is disconnecting and i have
// to constantly refresh the page": nothing in this app caught a render error anywhere.
render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
  document.getElementById("root")!,
);
