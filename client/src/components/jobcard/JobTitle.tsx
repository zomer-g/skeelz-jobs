interface JobTitleProps {
  title: string;
}

function JobTitle({title}:JobTitleProps) {
    return (
      <h4 className='font-EzerThinLoft display-5 fw-bolder p-5'>{title}</h4>
    );
  }
  
  export default JobTitle;