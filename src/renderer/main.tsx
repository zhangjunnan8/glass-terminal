import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './message-actions.css';

createRoot(document.getElementById('root')!).render(
  <App />,
);
