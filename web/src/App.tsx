import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { DialogHost, Loading, Toaster } from './components/ui';
import Launcher from './pages/Launcher';
import Login from './pages/Login';

const KioskApp = lazy(() => import('./kiosk/KioskApp'));
const CashierApp = lazy(() => import('./cashier/CashierApp'));
const KdsApp = lazy(() => import('./kds/KdsApp'));
const QueueDisplay = lazy(() => import('./queue/QueueDisplay'));
const AdminApp = lazy(() => import('./admin/AdminApp'));
const OrderLookup = lazy(() => import('./pages/OrderLookup'));
const PublicSite = lazy(() => import('./parkweb/PublicSite'));
const MemberPortal = lazy(() => import('./member/MemberPortal'));
const ParkKiosk = lazy(() => import('./parkkiosk/ParkKiosk'));
const LockerStation = lazy(() => import('./parkkiosk/LockerStation'));

export default function App() {
  return (
    <>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Launcher />} />
          <Route path="/login" element={<Login />} />
          <Route path="/kiosk/*" element={<KioskApp />} />
          <Route path="/cashier/*" element={<CashierApp />} />
          <Route path="/kds" element={<KdsApp />} />
          <Route path="/kds/:stationId" element={<KdsApp />} />
          <Route path="/queue" element={<QueueDisplay />} />
          <Route path="/queue/:branchCode" element={<QueueDisplay />} />
          <Route path="/admin/*" element={<AdminApp />} />
          <Route path="/o/:id" element={<OrderLookup />} />
          <Route path="/park/*" element={<PublicSite />} />
          <Route path="/member/*" element={<MemberPortal />} />
          <Route path="/park-kiosk" element={<ParkKiosk />} />
          <Route path="/locker" element={<LockerStation />} />
          <Route path="*" element={<Launcher />} />
        </Routes>
      </Suspense>
      <Toaster />
      <DialogHost />
    </>
  );
}
