import { useEffect } from 'react';
import { Stack, useRouter, useSegments, useRootNavigationState } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useGardenStore } from '../src/store/useGardenStore';
import { supabase, isSupabaseConfigured } from '../src/lib/supabase';

export default function RootLayout() {
  const { session, setSession } = useGardenStore();
  const segments = useSegments();
  const router = useRouter();
  const navigationState = useRootNavigationState();

  useEffect(() => {
    if (!isSupabaseConfigured) return;

    supabase.auth.getSession().then(({ data }) => setSession(data.session));

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) =>
      setSession(s)
    );
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!navigationState?.key) return;
    const inAuth = segments[0] === '(auth)';
    if (!session && !inAuth) {
      router.replace('/(auth)/login');
    } else if (session && inAuth) {
      router.replace('/(tabs)');
    }
  }, [session, segments, navigationState?.key]);

  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="plant/add"
          options={{
            presentation: 'modal',
            headerShown: true,
            headerTitle: 'Pflanze hinzufügen',
            headerTintColor: '#2D6A4F',
          }}
        />
        <Stack.Screen
          name="plant/[id]"
          options={{
            headerShown: true,
            headerTitle: 'Pflanze',
            headerTintColor: '#2D6A4F',
            headerBackTitle: 'Zurück',
          }}
        />
      </Stack>
    </>
  );
}
