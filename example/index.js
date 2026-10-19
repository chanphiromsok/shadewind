import { AppRegistry } from 'react-native';
import App from './src/App';
import { name as appName } from './app.json';
import { installUniwind } from 'shadewind/uniwind';

// after the app import: global.css (imported by App) has filled Uniwind's store by now
installUniwind();

AppRegistry.registerComponent(appName, () => App);
