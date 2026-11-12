import { Button, Col,Container,Modal,Row } from 'react-bootstrap';
function ModalJobDescription({jobDescription: string}) {
    const arr=["איתור וגיוס משאבים כספיים מתורמים פרטיים/קרנות/חברות עסקיות/משרדי ממשלה/עזבונות בארץ ובחו","טיפוח מעגלים של תמיכה ותרומה לחווה. ","גיוס משאבים בשווי ערך כספי. ","אירוח תורמים."]
    return (
  <div className='align-items-center mb-2 pb-2 fs-6 text-color-black'>
                  <span className='fs-3 fw-bold text-color-black'>כותרת</span>
                  <ul>
                  {arr.map((item, index)=>{
                    return( 
                              <li key={'jobDescription' + index}>{item}</li>
                            );
                          })}
                  </ul>
              </div>      
    );
  }
  
  export default ModalJobDescription;
  
  