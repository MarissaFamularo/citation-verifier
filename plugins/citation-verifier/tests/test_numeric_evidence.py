import sys,pathlib,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'skills'/'verify-citations'/'scripts'))
from numeric_evidence import missing_numbers

class NumericTests(unittest.TestCase):
 def test_controls(self):
  cases=[
   ('28% of people','28 percent of people',True),
   ('28 percent of people','28 % of people',True),
   ('28% of people','28 per cent of people',True),
   ('28% of people','28 people',False),
   ('28% of people','29 percent of people',False),
   ('28% of people','0.28 of people',False),
   ('95.8% of men','TABLE 1 Survey, % (SE) Men 95.8 (0.3)',True),
   ('95.8% of men','TABLE 1 Survey, mg/d (SE) Men 95.8 (0.3)',False),
   ('95.8% of men','TABLE 1 Survey, % (SE) Men 28.0 (95.8)',False),
   ('95.8% of men','TABLE 1 Survey, % (SE) Men 80 (0.3) TABLE 2 mg/d (SE) Men 95.8 (0.3)',False),
   ('> 3,400 mg/d','Mean 3,468 mg/day',True),
   ('over 3,400 mg/d','Mean 3 468 mg/day',True),
   ('> 3,400 mg/d','Mean 3,400 mg/day',False),
   ('> 3,400 mg/d','Mean 3,399 mg/day',False),
   ('> 3,400 mg/d','Mean 3,468 g/day',False),
   ('> 3,400 mg/d','Less than 3,468 mg/day',False),
   ('> 3,400 mg/d','Not over 3,400 mg/day',False),
   ('≥ 3,400 mg/d','Mean 3,400 mg/day',True),
   ('< 3,400 mg/d','Mean 3,399 mg/day',True),
   ('< 3,400 mg/d','Mean 3,401 mg/day',False),
   ('3,400 mg/d','Mean 3,468 mg/day',False),
   ('nearly 100,000 individuals','98 261 participants',True),
   ('nearly 100,000 individuals','98\u202f261 participants',True),
   ('nearly 100,000 individuals','95,000 participants',True),
   ('nearly 100,000 individuals','94,999 participants',False),
   ('nearly 100,000 individuals','100,001 participants',False),
   ('nearly 100,000 individuals','100,000 participants',False),
   ('nearly 100,000 individuals','98,261 person-years',False),
   ('100,000 individuals','98,261 participants',False),
   ('about 100,000 individuals','104,999 participants',True),
   ('about 100,000 individuals','105,000 participants',False),
   ('nearly 28% of people','27 percent of people',False),
   ('HR 0.94','HR 0·94',True),
   ('HR 0.94','HR 0.95',False),
   ('−0.94','0.94',False),
   ('52% and 71% reductions','a 20-person feasibility study',False),
  ]
  for claim,source,expected in cases:
   with self.subTest(claim=claim,source=source): self.assertEqual(not missing_numbers(claim,source),expected)

if __name__=='__main__':unittest.main()
