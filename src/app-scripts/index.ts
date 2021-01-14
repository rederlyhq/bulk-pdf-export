import configurations from '../configurations';
import { listen } from '../server';

(async () => {
    await configurations.loadPromise;
    await listen();
})();
