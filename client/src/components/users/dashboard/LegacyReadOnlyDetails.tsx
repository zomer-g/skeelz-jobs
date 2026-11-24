// A candidate of the existing site, copied here until the cutover (server/src/services/legacyCandidates.ts): the
// personal area shows their details as they are and says that editing opens after the move. The server refuses any
// change to the details (409 candidate_read_only); this only explains it. The marketing choice is theirs, not a
// detail of the profile: the same switch as every candidate (PUT /users/me/marketing-consent), so "you can join again
// in the personal area" on the unsubscribe page is true for them too.
import { useEffect, useState } from 'react';
import { UserService } from '../../../services/api/User.service';
import { i18n } from '../../../i18n/I18n';
import { isString } from '../../../utils/utils';
import { LocationService } from '../../../services/api/Location.service';
import { SkillsService } from '../../../services/api/Skills.service';
import MarketingConsentToggle from '../../consent/MarketingConsentToggle';

const GENDER: Record<string, string> = { male: 'זכר', female: 'נקבה', other: 'אחר' };

export default function LegacyReadOnlyDetails({ onReadOnly }: { onReadOnly: (readOnly: boolean) => void }) {
  const t = i18n.getTranslations().Profile;
  const [user, setUser] = useState<any | null>(null);
  const [city, setCity] = useState('');
  const [skills, setSkills] = useState('');

  useEffect(() => {
    let alive = true;
    UserService.getInstance().getMe().then((me) => {
      if (!alive || isString(me)) return;
      onReadOnly(!!me.readOnly);
      if (!me.readOnly) return;
      setUser(me.user);
      // Town and skills by name (the public lists; the record holds their ids).
      const symbol = Number(me.user?.citySymbol);
      if (symbol) LocationService.getInstance().fetchAllLocations().then((l) => {
        if (alive && !isString(l)) setCity(l.find((x) => Number(x.citySymbol) === symbol)?.city ?? '');
      });
      const ids: string[] = Array.isArray(me.user?.skills) ? me.user.skills.map(String) : [];
      if (ids.length) SkillsService.getInstance().fetchSkillsListRequest().then((r) => {
        if (alive && !isString(r)) setSkills(r.skills.filter((x) => ids.includes(String(x._id))).map((x) => x.name).join(', '));
      });
    });
    return () => { alive = false; };
  }, [onReadOnly]);

  if (!user) return null;
  const dob = user.dateOfBirth ? new Date(user.dateOfBirth).toLocaleDateString('he-IL') : '';
  const rows: [string, string][] = [
    [t.ReadOnlyName, `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()],
    [t.ReadOnlyEmail, user.email ?? ''],
    [t.ReadOnlyPhone, user.phoneNumber ?? ''],
    [t.ReadOnlyBirth, dob],
    [t.ReadOnlyGender, GENDER[user.gender] ?? ''],
    [t.ReadOnlyCity, city],
    [t.ReadOnlySkills, skills],
  ];
  return (
    <section className="border rounded-3 p-3 my-3" aria-labelledby="legacy-readonly-title" dir="rtl">
      <h2 id="legacy-readonly-title" className="fs-5 font-RubikMedium">{t.ReadOnlyTitle}</h2>
      <p className="mb-2">{t.ReadOnlyText}</p>
      <dl className="row mb-0">
        {rows.filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="col-12 col-md-6 d-flex gap-2">
            <dt className="font-RubikMedium">{k}:</dt>
            <dd className="mb-1" dir={k === t.ReadOnlyEmail || k === t.ReadOnlyPhone ? 'ltr' : undefined}>{v}</dd>
          </div>
        ))}
      </dl>
      <MarketingConsentToggle className="mt-3" />
    </section>
  );
}
