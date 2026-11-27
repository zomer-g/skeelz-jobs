import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Jobs from './components/Jobs/Jobs';
import AuthRouteGuard from './components/guards/AuthRouteGuard';
import { languageStore } from './store/Language.store';
import Footer from './components/footer/Footer';
import UpdateNotice from './components/pwa/UpdateNotice';
import Body from './components/body/Body';
import { StaticRouter } from 'react-router-dom/server';
import Header from './components/header/Header';
import { InitialData } from './models/interfaces/General.interfaces';
import './App.scss'

import NoSSR from './components/common/NoSSR';
import { UserRole, VIEWER_ROLES } from './i18n/General.enums';
// Settings (sign-up form, job form, applying): content managers and admins (server: contentManagerOnly).
const CONTENT_ROLES = [UserRole.CONTENT_MANAGER, UserRole.ADMIN];
import { ClientRoutes } from './i18n/ClientRoutes.enum';




import PrivacyPage from './components/privacy/PrivacyPage';

import PostJobPage from './components/employer/PostJobPage';


import NoticeBanner from './components/consent/NoticeBanner';
import ApplyConsentDialog from './components/consent/ApplyConsentDialog';
import ThresholdConfirmDialog from './components/threshold/ThresholdConfirmDialog';
import { usePageViews } from './utils/analytics';
import NotFoundPage from './components/common/NotFoundPage';

// Staff, employer and developer screens load on demand: the board's first load does not carry their code.
const JobsManagement = lazy(() => import('./components/JobsManagement'));
const UsersManagement = lazy(() => import('./components/users/UsersManagement'));
const JobsApplicationsManagement = lazy(() => import('./components/users/dashboard/jobApplicationsManagement'));
const SecurityManagement = lazy(() => import('./components/security/SecurityManagement'));
const StaffManagement = lazy(() => import('./components/users/StaffManagement'));
const SettingsPage = lazy(() => import('./components/settings/SettingsPage'));
const JobSubmissionsReview = lazy(() => import('./components/employer/JobSubmissionsReview'));
const EmployerArea = lazy(() => import('./components/employer/EmployerArea'));
const DevelopersPage = lazy(() => import('./components/developers/DevelopersPage'));
const JoinRolePage = lazy(() => import('./components/register/JoinRolePage'));
const MailManagement = lazy(() => import('./components/mail/MailManagement'));
const UnsubscribePage = lazy(() => import('./components/consent/UnsubscribePage'));

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
            <Suspense fallback={null}>
            <Routes>
              {/* Jobs and candidates: coordinators (view candidates, edit jobs), content managers and admins.
                  Security and staff users: admins only. */}
              <Route element={<AuthRouteGuard requiredRoles={VIEWER_ROLES} />}>
                <Route path={ClientRoutes.JobsManagement} element={
                <NoSSR isServer={isServer}>
                    <JobsManagement />
                  </NoSSR>
                } />
              </Route>
              {/* Candidates: coordinators (view only), content managers and admins. */}
              <Route element={<AuthRouteGuard requiredRoles={VIEWER_ROLES} />}>
                <Route path={ClientRoutes.UsersManagement} element={
                  <NoSSR isServer={isServer}>
                    <UsersManagement />
                  </NoSSR>
                  } />
              </Route>
              {/* Settings: content managers and admins (owner, 23.11.2026), never coordinators. */}
              <Route element={<AuthRouteGuard requiredRoles={CONTENT_ROLES} />}>
                <Route path={ClientRoutes.Settings} element={
                  <NoSSR isServer={isServer}>
                    <SettingsPage />
                  </NoSSR>
                  } />
              </Route>
              <Route element={<AuthRouteGuard requiredRoles={[UserRole.ADMIN]} />}>
                <Route path={ClientRoutes.SecurityManagement} element={
                  <NoSSR isServer={isServer}>
                    <SecurityManagement />
                  </NoSSR>
                  } />
                <Route path={ClientRoutes.StaffManagement} element={
                  <NoSSR isServer={isServer}>
                    <StaffManagement />
                  </NoSSR>
                  } />
              </Route>
              {/* Staff review of employer submissions. Same guard as /jobs-management; the server gate is contentGate (routes.ts). */}
              <Route element={<AuthRouteGuard requiredRoles={VIEWER_ROLES} />}>
                <Route path={ClientRoutes.JobSubmissions} element={
                  <NoSSR isServer={isServer}>
                    <JobSubmissionsReview />
                  </NoSSR>
                  } />
              </Route>
              {/* Service emails: events and templates. Content managers and admins (server gate contentManagerOnly). */}
              <Route element={<AuthRouteGuard requiredRoles={[UserRole.CONTENT_MANAGER, UserRole.ADMIN]} />}>
                <Route path={ClientRoutes.MailManagement} element={
                  <NoSSR isServer={isServer}>
                    <MailManagement />
                  </NoSSR>
                  } />
              </Route>
              {/* The employer's own area (server gate employerOnly). */}
              <Route element={<AuthRouteGuard requiredRoles={[UserRole.EMPLOYER]} />}>
                <Route path={ClientRoutes.EmployerArea} element={
                  <NoSSR isServer={isServer}>
                    <EmployerArea />
                  </NoSSR>
                  } />
              </Route>
              {/* Several roles per account (23.11.2026): any signed-in account adds the candidate / employer role to itself. */}
              <Route element={<AuthRouteGuard requiredRoles={[...VIEWER_ROLES, UserRole.USER, UserRole.EMPLOYER]} />}>
                <Route path={ClientRoutes.JoinAsCandidate} element={<NoSSR isServer={isServer}><JoinRolePage role="candidate" /></NoSSR>} />
                <Route path={ClientRoutes.JoinAsEmployer} element={<NoSSR isServer={isServer}><JoinRolePage role="employer" /></NoSSR>} />
              </Route>
              <Route path={ClientRoutes.Privacy} element={<PrivacyPage />} />
              <Route path={ClientRoutes.Unsubscribe} element={<NoSSR isServer={isServer}><UnsubscribePage /></NoSSR>} />
              <Route path={ClientRoutes.Developers} element={<DevelopersPage />} />
              <Route path={ClientRoutes.PostJob} element={<PostJobPage />} />
              <Route path={ClientRoutes.JobPage} element={
                <NoSSR isServer={isServer}>
                  <Jobs jobList={initialData?.jobList?.data} />
                </NoSSR>
              } />
              <Route element={<AuthRouteGuard requiredRoles={[...VIEWER_ROLES, UserRole.USER]} />}>
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
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
            </Suspense>
          </Body>
        </main>
        <Footer />
        {!isServer && <NoticeBanner />}
        {/* No consent step on entering the site (owner, 27.11.2026): consent is asked only when signing up or applying. */}
        {!isServer && <ApplyConsentDialog />}
        {!isServer && <ThresholdConfirmDialog />}
        {!isServer && <UpdateNotice />}
      </div>
    </Router>
  );
}

export default App;