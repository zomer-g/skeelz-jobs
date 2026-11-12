interface jobType {
  j_type: string;
}
function JobType({ j_type}: jobType) {
  const fullTimeJob = 'משרה מלאה';
  return (
    <>
    <div className={j_type==fullTimeJob?'font-EzerThinLoft fw-bold text-bold-purple-1 text-color-purple pt-2 pb-2':'font-EzerThinLoft fw-bold text-bold-dark-green-1 text-color-dark-green pt-2 pb-2'}>
        <h5>{j_type}</h5>
    </div>
    </>
  );
}

export default JobType;
