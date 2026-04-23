import { Camera } from 'expo-camera';
import { Alert, Linking } from 'react-native';

export async function requestCameraPermission(): Promise<boolean> {
  const { status } = await Camera.requestCameraPermissionsAsync();
  if (status === 'granted') return true;

  Alert.alert(
    'Kamerazugriff benötigt',
    'GartenApp benötigt Kamerazugriff, um Pflanzen zu fotografieren. Bitte erlaube den Zugriff in den Einstellungen.',
    [
      { text: 'Abbrechen', style: 'cancel' },
      { text: 'Einstellungen öffnen', onPress: () => Linking.openSettings() },
    ]
  );
  return false;
}
