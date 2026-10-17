import { render } from 'preact';
import { effect, untracked } from '@preact/signals';
import { initializeRuntime, showStartupError } from './runtime';
import { ViewerController } from './render/viewerEngine';
import { startViewerState, viewerError, viewerOptions, viewerReady } from './state/viewer';
import { initializeDiagnostics } from './state/diagnostics';
import App from './App';
import './base.css';

void initializeRuntime()
  .then(() => {
    const root = document.getElementById('root')!;
    const viewport = document.getElementById('viewport')!;
    const stopState = startViewerState();
    initializeDiagnostics();
    let controller: ViewerController | null = null;
    const stopOptions = effect(() => {
      const options = viewerOptions.value;
      untracked(() => {
        if (!options.world) {
          controller?.dispose();
          controller = null;
          viewerReady.value = false;
        } else if (controller) controller.update(options);
        else {
          viewerError.value = null;
          controller = new ViewerController(
            viewport,
            options,
            (message) => {
              viewerError.value = message;
            },
            () => {
              viewerReady.value = true;
            },
          );
        }
      });
    });
    render(<App />, root);
    import.meta.hot?.dispose(() => {
      stopOptions();
      controller?.dispose();
      stopState();
      render(null, root);
    });
  })
  .catch(showStartupError);
