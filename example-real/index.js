import { AppRegistry } from 'react-native';
import App from './App';
// after the app: global.css has filled Uniwind's store by now (installUniwind also retries on an empty store)
import './src/boot';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
