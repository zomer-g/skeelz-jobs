import { JobInfoData } from '../../models/interfaces/Props.interfaces';

function JobInfo(jobInfo: JobInfoData) {
  const isLink = jobInfo.infoUrl === true;
  const fullInfo: string = jobInfo.info ?? '';

  const link = fullInfo.startsWith('http')
    ? fullInfo
    : fullInfo.includes('@')
    ? `mailto:${fullInfo}`
    : fullInfo.match(/^\d{7,}$/)
    ? `tel:${fullInfo}`
    : `https://${fullInfo}`;

  const MAX_LENGTH = 25;
  const displayText =
    !jobInfo.noTruncate && fullInfo.length > MAX_LENGTH ? fullInfo.slice(0, MAX_LENGTH) + '…' : fullInfo;

  return (
    <div className='d-flex align-items-center height-2-375rem'>
      {jobInfo.icon}
      <span className='font-RubikRegular text-pre-wrap text-color-dark-grey pe-2'>
        {jobInfo.title + " "}
      </span>
      {isLink ? (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className={`font-RubikMedium text-decoration-underline text-primary${jobInfo.noTruncate ? ' text-break' : ''}`}
          title={fullInfo}
        >
          {displayText}
        </a>
      ) : (
        <span className='font-RubikMedium'>{displayText}</span>
      )}
    </div>
  );
}

export default JobInfo;
