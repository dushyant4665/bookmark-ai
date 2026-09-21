import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './state/AuthContext';
import { WorkspaceProvider } from './state/WorkspaceContext';
import { Workspace } from './components/Workspace';
import { AuthView } from './components/AuthView';
import { Landing } from './components/Landing';
import { Spinner } from './components/ui';

type Route = 'site' | 'signin' | 'register';

// A hash is enough for three destinations and keeps the app dependency-free.
// The workspace needs no routing: it is what you see once you are signed in.
function useRoute(): Route {
  const read = (): Route =>
    window.location.hash === '#/signin' ? 'signin' : window.location.hash === '#/register' ? 'register' : 'site';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

function Shell() {
  const { status } = useAuth();
  const route = useRoute();

  if (status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Loading…" />
      </div>
    );
  }
  if (status === 'anonymous') {
    return route === 'site' ? <Landing /> : <AuthView mode={route === 'register' ? 'register' : 'login'} />;
  }

  return (
    <WorkspaceProvider>
      <Workspace />
    </WorkspaceProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
