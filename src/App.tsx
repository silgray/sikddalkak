import { CellStack } from './components/CellStack';

export default function App() {
  return (
    <main className="app">
      <header className="app-header">
        <h1>sikddalkak</h1>
        <p>
          Type an expression and press <kbd>Enter</kbd> to simplify it.
          <br />
          Write <code>a = 3</code> to define a variable the cells below can use.
        </p>
      </header>
      <CellStack />
    </main>
  );
}
