import { createRoot } from 'react-dom/client';
import { SettingsWindow } from './SettingsWindow';
import './styles.css';
import './settings.css';

createRoot(document.getElementById('root')!).render(
  <SettingsWindow />,
);
