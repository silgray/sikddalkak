import { Workspace } from './components/Workspace';
import { HelpPanel } from './components/HelpPanel';

export default function App() {
  return (
    <main className="app">
      <header className="app-header">
        <div className="app-header-row">
          <h1>sikddalkak</h1>
          <HelpPanel />
        </div>
        <p>
          Type an expression and press <kbd>Enter</kbd> to simplify it.
          <br />
          Write <code>a = 3</code> to define a variable other cells can use.
        </p>
      </header>
      <Workspace />
    </main>
  );
}
