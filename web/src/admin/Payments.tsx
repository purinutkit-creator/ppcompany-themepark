import { Link } from 'react-router-dom';
import { PageHeader, Button } from '../components/ui';
import { PaymentHistory } from '../cashier/PaymentHistory';
import { tt } from '../lib/legacy-i18n';

export default function Payments() {
  return (
    <div>
      <PageHeader title={tt('Payments')} sub={tt('Every payment attempt with method, provider, reference and who confirmed it')} actions={<Link to="/cashier/verify"><Button variant="outline">{tt('Open Slip Verification Center')}</Button></Link>} />
      <div className="-m-5">
        <PaymentHistory />
      </div>
    </div>
  );
}
