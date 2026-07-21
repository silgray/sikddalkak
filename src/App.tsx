import { CellStack } from './components/CellStack';

export default function App() {
  return (
    <main className="app">
      <header className="app-header">
        <h1>식딸깍</h1>
        <p>
          수식을 입력하고 <kbd>Enter</kbd> 를 누르면 정리된 식이 나옵니다.
          <br />
          <code>a = 3</code> 처럼 쓰면 아래 셀에서 그 변수를 쓸 수 있습니다.
        </p>
      </header>
      <CellStack />
    </main>
  );
}
