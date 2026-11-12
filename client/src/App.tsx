import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Jobs from './components/Jobs/Jobs';
import AuthRouteGuard from './components/guards/AuthRouteGuard';
import { languageStore } from './store/Language.store';
import Footer from './components/footer/Footer';
import Body from './components/body/Body';
import { StaticRouter } from 'react-router-dom/server';
import Header from './components/header/Header';
import { InitialData } from './models/interfaces/General.interfaces';
import './App.scss'
import JobsManagement from './components/JobsManagement';
import NoSSR from './components/common/NoSSR';
import { UserRole } from './i18n/General.enums';
import { ClientRoutes } from './i18n/ClientRoutes.enum';
import UsersManagement from './components/users/UsersManagement';
import JobsApplicationsManagement from './components/users/dashboard/jobApplicationsManagement';
import SecurityManagement from './components/security/SecurityManagement';
import PrivacyPage from './components/privacy/PrivacyPage';
import DevelopersPage from './components/developers/DevelopersPage';
import PostJobPage from './components/employer/PostJobPage';
import JobSubmissionsReview from './components/employer/JobSubmissionsReview';
import ConsentBanner from './components/consent/ConsentBanner';
import { usePageViews } from './utils/analytics';

/** One GA4 page_view per route change (no-op unless analytics is on and accepted). */
const PageViews: React.FC = () => { usePageViews(); return null; };

interface AppProps {
  isServer: boolean;
  location?: string;
  initialData?: InitialData;
}

const App: React.FC<AppProps> = ({
  isServer,
  location,
  // In SSR, initialData comes from the context; on the client, it falls back to window.__INITIAL_DATA__
  initialData = window?.__INITIAL_DATA__ as InitialData,
}) => {
  const { currentLanguage } = languageStore();


  const Router = isServer ? StaticRouter : BrowserRouter;
  const resolvedLocation = location ?? '/';
  return (
    <Router location={resolvedLocation}>
      {!isServer && <PageViews />}
      <div className={`direction_${currentLanguage} d-flex flex-column min-vh-100`}>
        <Header activeJob={initialData?.activeJob} activeJobIndex={initialData?.activeJobIndex} />
        <main className="flex-grow-1">
          <Body >
            <Routes>
              {/* Jobs and candidates: content managers only. Security and staff users: admins only. */}
              <Route element={<AuthRouteGuard requiredRoles={[UserRole.CONTENT_MANAGER]} />}>
                <Route path={ClientRoutes.JobsManagement} element={
                <NoSSR isServer={isServer}>
                    <JobsManagement />
                  </NoSSR>
                } />
              </Route>
              {/* Content manager → candidates; admin → staff users (UsersManagement picks by role). */}
              <Route element={<AuthRouteGuard requiredRoles={[UserRole.CONTENT_MANAGER, UserRole.ADMIN]} />}>
                <Route path={ClientRoutes.UsersManagement} element={
                  <NoSSR isServer={isServer}>
                    <UsersManagement />
                  </NoSSR>
                  } />
              </Route>
              <Route element={<AuthRouteGuard requiredRoles={[UserRole.ADMIN]} />}>
                <Route path={ClientRoutes.SecurityManagement} element={
                  <NoSSR isServer={isServer}>
                    <SecurityManagement />
                  </NoSSR>
                  } />
              </Route>
              {/* Staff review of employer submissions. Same guard as /jobs-management; the server gate is contentGate (routes.ts). */}
              <Route element={<AuthRouteGuard requiredRoles={[UserRole.CONTENT_MANAGER]} />}>
                <Route path={ClientRoutes.JobSubmissions} element={
                  <NoSSR isServer={isServer}>
                    <JobSubmissionsReview />
                  </NoSSR>
                  } />
              </Route>
              <Route path={ClientRoutes.Privacy} element={<PrivacyPage />} />
              <Route path={ClientRoutes.Developers} element={<DevelopersPage />} />
              <Route path={ClientRoutes.PostJob} element={<PostJobPage />} />
              <Route path={ClientRoutes.ResetPassword} element={
                <NoSSR isServer={isServer}>
                  <Jobs jobList={initialData?.jobList?.data} />
                </NoSSR>
              } />
              <Route path={ClientRoutes.InitializePassword} element={
                <NoSSR isServer={isServer}>
                  <Jobs jobList={initialData?.jobList?.data} />
                </NoSSR>
              } />
              <Route path={ClientRoutes.JobPage} element={
                <NoSSR isServer={isServer}>
                  <Jobs jobList={initialData?.jobList?.data} />
                </NoSSR>
              } />
              <Route element={<AuthRouteGuard requiredRoles={[UserRole.ADMIN, UserRole.CONTENT_MANAGER, UserRole.USER]} />}>
                <Route path={ClientRoutes.JobApplicationsManagement} element={
                  <NoSSR isServer={isServer}>
                    <JobsApplicationsManagement />
                  </NoSSR>
                } />
              </Route>
              <Route path={ClientRoutes.MainPage} element={
                <NoSSR isServer={isServer}>
                  <Jobs
                    jobList = {initialData?.jobList?.data}
                    isServer = {isServer}
                  />
                </NoSSR>
              } />
            </Routes>
          </Body>
        </main>
        <Footer />
        {!isServer && <ConsentBanner />}
      </div>
    </Router>
  );
}

export default App;