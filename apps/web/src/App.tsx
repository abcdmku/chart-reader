import { useAppState } from './useAppState';
import { Dashboard } from './pages/Dashboard';

export function App() {
  const state = useAppState();

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <Dashboard state={state} />
    </div>
  );
}
